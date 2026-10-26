/**
 * OpenAI `/v1/chat/completions` <-> Kiro wire 的翻译层。
 *
 * 纯数据变换：不碰网络，也不碰时钟（只有 state 构造器在缺省 `created` 时取一次
 * 当前时间）。调用方负责把返回的字符串包成 `data: ...\n\n`。
 *
 * 请求方向只负责把 OpenAI 的消息词汇表读成统一轮次，交替、折叠、工具结果配对
 * 和 system 前置都交给 `kiro-history.js`。响应方向需要注意：Kiro 的 toolUseEvent
 * 是「name → 若干 input 片段 → stop」三段式，必须按 `toolUseId` 归并成 OpenAI 的
 * `tool_calls[index]` 增量逐个吐出；缓冲整段再发会让客户端一直空转。
 *
 * @module dsh-kiro-proxy/kiro-openai
 */

import { randomUUID } from 'node:crypto'

import { kiroError } from './kiro-error.js'
import {
  emptyTurn,
  finishRequest,
  generationFields,
  imageOnWrongTurn,
  isRecord,
  joinSystem,
  openRequest,
  pushTurn,
  toolNameFor,
  toolUseIdFor,
} from './kiro-history.js'

/** data: URL 里的 MIME -> Kiro ImageFormat。 */
const MIME_TO_FORMAT = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
/** `data:<mime>[;param...],<payload>` */
const DATA_URL = /^data:([^;,]+)((?:;[^,]*)*),(.*)$/s
/** 走 tool 角色的消息：工具结果挂在 user 轮的 per-turn context 上。 */
const TOOL_ROLES = new Set(['tool', 'function'])

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 归一化 stopReason 便于查表。
 *
 * Kiro 的枚举是 UPPER_SNAKE，生命周期与代理层有时用 lower snake / camelCase，
 * 归一化后映射表才只需要一套 key。
 * @param {unknown} reason - 原始值。
 * @returns {string} UPPER_SNAKE 形态；无值返回空串。
 */
function normalizeStopReason(reason) {
  if (typeof reason !== 'string') return ''
  return reason
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toUpperCase()
}

/**
 * 把 data: URL 转成 Kiro 的 ImageBlock。
 *
 * Kiro 的 `ImageSource` 只有 `bytes` 一个成员，服务端不会替我们下载远程图片，
 * 所以 http(s) URL 必须显式报错，而不是假装图已经发出去了。
 * @param {unknown} url - `image_url.url`，或直接是字符串形式的 `image_url`。
 * @returns {{format: string, source: {bytes: string}}}
 * @throws `INVALID_REQUEST` / `UNSUPPORTED_CONTENT`。
 */
function imageFromUrl(url) {
  const value = typeof url === 'string' ? url.trim() : ''
  if (value === '') throw kiroError('OpenAI image_url part carries no url', 'INVALID_REQUEST')
  if (/^https?:\/\//i.test(value)) {
    throw kiroError('Kiro cannot fetch remote images; send the image as a data: URL', 'UNSUPPORTED_CONTENT')
  }
  const parts = DATA_URL.exec(value)
  if (parts === null) throw kiroError('OpenAI image_url must be a data: URL', 'UNSUPPORTED_CONTENT')
  const [, rawMime, params = '', payload = ''] = parts
  const mime = rawMime.trim().toLowerCase()
  const format = Object.hasOwn(MIME_TO_FORMAT, mime) ? MIME_TO_FORMAT[mime] : undefined
  if (format === undefined) throw kiroError(`Kiro does not accept ${mime} images`, 'UNSUPPORTED_CONTENT')
  // 非 base64 的 data URL 合法但少见：按百分号编码还原成字节再转 base64。
  const bytes = /;base64/i.test(params)
    ? payload.replace(/\s+/g, '')
    : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64')
  return { format, source: { bytes } }
}

/**
 * 读一条 OpenAI 消息的 content：字符串、part 数组，或者（个别客户端）单个 part。
 *
 * 只有 user 与 tool 轮能带图：tool 结果最终挂在 user 轮上，图片随之落座；
 * assistant / system / developer 在 wire 上没有图片槽位。
 * @param {unknown} content
 * @param {string} role - 仅用于错误信息与图片策略。
 * @returns {{text: string, images: object[]}}
 */
function readOpenAiContent(content, role) {
  if (content === null || content === undefined) return { text: '', images: [] }
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) {
    if (isRecord(content) && typeof content.text === 'string') return { text: content.text, images: [] }
    throw kiroError('OpenAI message content must be a string or an array of parts', 'INVALID_REQUEST')
  }
  const pieces = []
  const images = []
  for (const part of content) {
    if (typeof part === 'string') {
      pieces.push(part)
    } else if (isRecord(part)) {
      if (part.type === 'text' || part.type === 'input_text') {
        if (typeof part.text === 'string') pieces.push(part.text)
      } else if (part.type === 'image_url' || part.type === 'input_image') {
        if (role !== 'user' && role !== 'tool') throw imageOnWrongTurn(role)
        const { image_url: ref } = part
        images.push(imageFromUrl(typeof ref === 'string' ? ref : ref?.url))
      }
      // 其余 part（refusal / audio / file …）Kiro 没有对应槽位，直接略过：
      // 为一个可选 part 让整轮请求失败代价更大。
    }
  }
  return { text: pieces.join(''), images }
}

/**
 * 解析 assistant tool_call 的 arguments。坏 JSON 给 `{}`：重放历史时，过去某轮
 * 的坏参数不该拖垮当前请求。
 * @param {unknown} raw
 * @returns {unknown}
 */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// 请求方向：OpenAI -> wire
// ---------------------------------------------------------------------------

/**
 * 把一条 OpenAI 消息读成一个统一轮次；system / developer 返回 undefined，
 * 其文本收进 `systemParts`。
 * @param {object} message
 * @param {Map<string, string>} toolNameMap
 * @param {string[]} systemParts
 * @returns {object|undefined}
 */
function readTurn(message, toolNameMap, systemParts) {
  const role = typeof message.role === 'string' ? message.role : 'user'
  const { text, images } = readOpenAiContent(message.content, role)

  if (role === 'system' || role === 'developer') {
    if (images.length > 0) throw imageOnWrongTurn(role)
    if (text !== '') systemParts.push(text)
    return undefined
  }

  if (role === 'assistant') {
    const turn = emptyTurn('assistant', text)
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!isRecord(call)) continue
      turn.toolUses.push({
        toolUseId: toolUseIdFor(call.id),
        name: toolNameFor(call.function?.name, toolNameMap),
        input: parseArguments(call.function?.arguments),
      })
    }
    return turn
  }

  // user / tool / function 都落进 user 轮：Kiro 没有独立的 tool 角色。
  if (!TOOL_ROLES.has(role)) return { ...emptyTurn('user', text), images }
  const turn = emptyTurn('user')
  turn.images = images
  turn.toolResults.push({
    toolUseId: toolUseIdFor(message.tool_call_id),
    // 空的工具输出在 wire 上也要有内容。
    content: [{ text: text === '' ? '(no output)' : text }],
    status: message.is_error === true ? 'error' : 'success',
  })
  return turn
}

/**
 * 读 OpenAI 的 tools 定义，兼容 `{type:'function', function:{...}}` 与已摊平的
 * `{name, description, parameters}` 两种写法。
 * @param {unknown} tools
 * @param {Map<string, string>} toolNameMap
 * @returns {object[]}
 */
function readTools(tools, toolNameMap) {
  if (!Array.isArray(tools)) return []
  const specs = []
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const spec = isRecord(tool.function) ? tool.function : tool
    if (typeof spec.name !== 'string' || spec.name === '') continue
    specs.push({
      toolSpecification: {
        name: toolNameFor(spec.name, toolNameMap),
        description: typeof spec.description === 'string' ? spec.description : '',
        inputSchema: { json: isRecord(spec.parameters) ? spec.parameters : { type: 'object', properties: {} } },
      },
    })
  }
  return specs
}

/**
 * OpenAI 的输出上限：`max_completion_tokens` 优先，旧字段 `max_tokens` 兜底。
 * @param {any} request
 * @returns {number|undefined}
 */
function requestedMaxTokens(request) {
  for (const key of ['max_completion_tokens', 'max_tokens']) {
    if (Number.isInteger(request[key])) return request[key]
  }
  return undefined
}

/**
 * 把 OpenAI 请求翻译成 Kiro wire 请求。
 *
 * @param {any} body - `/v1/chat/completions` 请求体。
 * @param {{modelId?: string, conversationId?: string, profileArn?: string,
 *   systemPrefix?: string, effort?: {schemaPath: 'output_config'|'reasoning', level: string},
 *   maxTokensBounds?: {minimum: number, maximum: number},
 *   maxTokensField?: string}} ctx - 路由侧提供的上下文。
 * @returns {{body: object, stream: boolean, model: string, toolNameMap: Map<string, string>}}
 *   wire 请求体、是否流式、响应里回报的模型名、wire 工具名 -> 客户端工具名。
 * @throws {Error} 参数不可用时抛带 code 的 kiroError。
 */
export function openAiToWire(body, ctx = {}) {
  const opened = openRequest(body, ctx, 'OpenAI')
  const toolNameMap = new Map()
  const systemParts = []
  const turns = []
  for (const message of opened.messages) {
    if (!isRecord(message)) continue
    const turn = readTurn(message, toolNameMap, systemParts)
    if (turn !== undefined) pushTurn(turns, turn)
  }
  return finishRequest(opened, {
    turns,
    tools: readTools(opened.request.tools, toolNameMap),
    system: joinSystem([ctx.systemPrefix, ...systemParts]),
    fields: generationFields(ctx, requestedMaxTokens(opened.request)),
    profileArn: ctx.profileArn,
    toolNameMap,
  })
}

// ---------------------------------------------------------------------------
// 响应方向：wire 事件 -> OpenAI chunk
// ---------------------------------------------------------------------------

/**
 * 建一个 OpenAI 流式状态。
 *
 * 调用方不用猜内部字段：所有跨事件累积（文本、reasoning、工具块、usage）
 * 都在这里初始化。
 * @param {{id?: string, model?: string, created?: number}} [init] - 可选的固定值。
 * @returns {object} state。
 */
export function newOpenAiState(init = {}) {
  return {
    /** 响应 id，客户端用它做幂等/日志关联。 */
    id: typeof init.id === 'string' && init.id.length > 0 ? init.id : `chatcmpl-${randomUUID()}`,
    /** 响应里回报的模型名（回显客户端请求的那个）。 */
    model: typeof init.model === 'string' && init.model.length > 0 ? init.model : 'kiro',
    /** 秒级时间戳，所有 chunk 共用同一个值。 */
    created: Number.isFinite(init.created) ? init.created : Math.floor(Date.now() / 1000),
    /** choice 下标；本模块只产出单 choice。 */
    index: 0,
    /** 已发出的 chunk 数，用于判断首个 delta 要不要带 role。 */
    chunkIndex: 0,
    /** 是否已经吐过 `role: 'assistant'`。 */
    sentRole: false,
    /** 下一个 tool_calls 的 index。 */
    toolIndex: 0,
    /** wire toolUseId -> {index, id, name, arguments, closed}。 */
    tools: new Map(),
    /** 工具块出现顺序，非流式响应按这个顺序组装。 */
    toolOrder: [],
    /** 累积的可见文本。 */
    text: '',
    /** 累积的 reasoning_content。 */
    reasoning: '',
    /** OpenAI 形态的 usage，收尾 chunk 才带上。 */
    usage: undefined,
    /** 最后一次 contextUsageEvent 的百分比，供调用方兜底计费。 */
    contextPercentage: undefined,
    /** 已确定的 finish_reason。 */
    finishReason: null,
    /** 原始 stopReason，留作诊断。 */
    stopReason: null,
    /** 流内错误；非流式路径据此抛错，流式路径据此发 error 负载。 */
    error: null,
    /** 收尾是否已经发过，防止重复收尾。 */
    closed: false,
  }
}

/**
 * 生成一个 SSE chunk 负载（不含 `data: ` 前缀与空行）。
 * @param {object} state - 流式状态。
 * @param {object} delta - choice.delta。
 * @param {string|null} finishReason - choice.finish_reason。
 * @param {object} [extra] - 追加到 chunk 顶层的不标准字段。
 * @returns {string} JSON 字符串。
 */
function chunkOf(state, delta, finishReason, extra) {
  return JSON.stringify({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: state.index, delta, finish_reason: finishReason }],
    ...extra === undefined ? {} : extra,
  })
}

/**
 * 发一个 delta，首个 delta 自动补 `role: 'assistant'`。
 * @param {object} state - 流式状态。
 * @param {object} delta - choice.delta。
 * @returns {string} JSON 字符串。
 */
function emitDelta(state, delta) {
  const payload = state.sentRole ? delta : { role: 'assistant', ...delta }
  state.sentRole = true
  state.chunkIndex += 1
  return chunkOf(state, payload, null)
}

/**
 * 取/建一个工具块。
 *
 * 按 `toolUseId` 归并是这段流式的核心：Kiro 的工具调用是"start(name) ->
 * 若干 input 片段 -> stop"三段式，而 OpenAI 的客户端按 `index` 累积同一路
 * 增量，两者必须由 id 做桥。
 * @param {object} state - 流式状态。
 * @param {string} id - wire toolUseId。
 * @param {string} name - 工具名。
 * @returns {object} 工具块。
 */
function ensureTool(state, id, name) {
  const key = id.length > 0 ? id : `call_${state.toolIndex}`
  const existing = state.tools.get(key)
  if (existing !== undefined) {
    if (name.length > 0) existing.name = name
    return existing
  }
  const block = { index: state.toolIndex, id: key, name, arguments: '', closed: false }
  state.toolIndex += 1
  state.tools.set(key, block)
  state.toolOrder.push(block)
  return block
}

/**
 * 把归一化事件翻译成 OpenAI SSE 负载。
 *
 * 逐事件增量：文本直接转发，工具参数按 id 追加，usage/stop 只记状态，
 * 真正的收尾由 `wireFinish` 负责（OpenAI 的 usage 只出现在最后一个 chunk）。
 * @param {{kind: string} & Record<string, unknown>} evt - kiro-client 归一化后的事件。
 * @param {object} state - `newOpenAiState` 的返回值。
 * @returns {string|undefined} SSE 负载 JSON，或 undefined 表示这一事件不吐东西。
 * @throws {Error} `kind: 'error'` 时抛带 code 的 kiroError，由调用方决定怎么落地。
 */
export function wireToOpenAiChunk(evt, state) {
  if (evt === null || typeof evt !== 'object') return undefined
  switch (evt.kind) {
    case 'text': {
      const text = typeof evt.text === 'string' ? evt.text : ''
      if (text.length === 0) return undefined
      state.text += text
      return emitDelta(state, { content: text })
    }
    case 'reasoning': {
      const text = typeof evt.text === 'string' ? evt.text : ''
      if (text.length === 0) return undefined
      state.reasoning += text
      return emitDelta(state, { reasoning_content: text })
    }
    case 'tool-start': {
      const block = ensureTool(state, typeof evt.id === 'string' ? evt.id : '', typeof evt.name === 'string' ? evt.name : '')
      return emitDelta(state, {
        tool_calls: [{
          index: block.index,
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: '' },
        }],
      })
    }
    case 'tool-delta': {
      const id = typeof evt.id === 'string' ? evt.id : ''
      const fragment = typeof evt.argumentsDelta === 'string' ? evt.argumentsDelta : ''
      const existing = state.tools.get(id)
      if (existing === undefined) {
        // 没见过 start 就直接来片段：惰性建块，把 id/name 与首段参数放进同一
        // 个 delta，客户端仍能按 index 归并。
        const block = ensureTool(state, id, '')
        block.arguments += fragment
        return emitDelta(state, {
          tool_calls: [{
            index: block.index,
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: fragment },
          }],
        })
      }
      existing.arguments += fragment
      return emitDelta(state, { tool_calls: [{ index: existing.index, function: { arguments: fragment } }] })
    }
    case 'tool-stop': {
      // 块本身已经按 index 增量发完，OpenAI 没有"工具块结束"这种帧，
      // 这里只记状态，让收尾逻辑知道这个块是完整的。
      const block = state.tools.get(typeof evt.id === 'string' ? evt.id : '')
      if (block !== undefined) block.closed = true
      return undefined
    }
    case 'usage': {
      state.usage = openAiUsage(evt)
      if (Number.isFinite(evt.contextPercentage)) state.contextPercentage = evt.contextPercentage
      return undefined
    }
    case 'stop': {
      state.stopReason = typeof evt.stopReason === 'string' ? evt.stopReason : null
      return undefined
    }
    case 'error': {
      // 不抛：流已经开始了，抛出去调用方只能掐断连接，客户端看到的是一次
      // 没有 finish_reason 的断流。按 OpenAI 的惯例在流里发一个 error 负载，
      // 客户端会把它当成本轮失败，但连接和已有内容都保住了。
      state.error = {
        message: typeof evt.message === 'string' && evt.message.length > 0
          ? evt.message
          : 'Kiro stream failed',
        code: typeof evt.code === 'string' && evt.code.length > 0 ? evt.code : 'UPSTREAM_ERROR',
      }
      state.closed = true
      return JSON.stringify({
        error: { message: state.error.message, type: 'upstream_error', code: state.error.code },
      })
    }
    default:
      // 协议只会靠新增 case 扩展，未知事件绝不当作正文吐出去。
      return undefined
  }
}

/**
 * 把 Kiro 的四个互斥桶映射成 OpenAI usage。
 *
 * `cached_tokens` 是 OpenAI 自己的缓存读口径，直接对应 Kiro 的
 * `cacheReadTokens`；写缓存 OpenAI 没有官方槽位，额外给一个
 * `cache_creation_tokens`（9router 用的是顶层 `cache_creation_input_tokens`，
 * 这里两个都放，谁读都能读到）。
 * @param {any} evt - usage 事件。
 * @returns {object} OpenAI usage。
 */
function openAiUsage(evt) {
  const prompt = Number.isFinite(evt.inputTokens) ? Math.max(0, evt.inputTokens) : 0
  const completion = Number.isFinite(evt.outputTokens) ? Math.max(0, evt.outputTokens) : 0
  const cached = Number.isFinite(evt.cacheReadTokens) ? Math.max(0, evt.cacheReadTokens) : 0
  const written = Number.isFinite(evt.cacheWriteTokens) ? Math.max(0, evt.cacheWriteTokens) : 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    ...cached > 0 ? { cache_read_input_tokens: cached } : {},
    ...written > 0 ? { cache_creation_input_tokens: written } : {},
  }
}

/**
 * stopReason -> OpenAI finish_reason。
 *
 * 单独抽出来是因为收尾 chunk 与非流式响应必须给出同一个答案。
 * @param {unknown} stopReason - 原始 stopReason。
 * @param {boolean} hasTools - 本轮是否真的发出过工具调用。
 * @returns {{finishReason: string, hint?: object}} finish_reason 与可选的诊断提示。
 */
function mapFinishReason(stopReason, hasTools) {
  switch (normalizeStopReason(stopReason)) {
    case 'END_TURN':
    case 'STOP':
    case 'STOP_SEQUENCE':
      return { finishReason: 'stop' }
    case 'TOOL_USE':
    case 'TOOL_CALLS':
      return { finishReason: 'tool_calls' }
    case 'MAX_TOKENS':
    case 'MAX_OUTPUT_TOKENS':
    case 'LENGTH':
      return { finishReason: 'length' }
    case 'MODEL_CONTEXT_WINDOW_EXCEEDED':
    case 'CONTEXT_WINDOW_EXCEEDED':
      // OpenAI 没有"上下文超限"这个 finish_reason，只能借 length 表达截断，
      // 再用一个附加字段把真实原因说清楚，否则客户端只会以为输出被截短。
      return {
        finishReason: 'length',
        hint: {
          code: 'MODEL_CONTEXT_WINDOW_EXCEEDED',
          message: 'Kiro stopped the turn because the model context window was exceeded',
        },
      }
    case 'CONTENT_FILTERED':
    case 'REFUSAL':
      return { finishReason: 'content_filter' }
    case 'PAUSE_TURN':
      return { finishReason: 'stop' }
    default:
      // 未知或缺失的 stopReason：按"已经产出了什么"收尾，绝不吞掉内容。
      return { finishReason: hasTools ? 'tool_calls' : 'stop' }
  }
}

/**
 * 收尾 chunk。
 *
 * usage 只挂在最后一个 chunk 上：OpenAI 的流式协议就是这样约定的，提前发会
 * 被部分客户端当成最终结果而提前关闭连接。
 * @param {object} state - 流式状态。
 * @param {string} [stopReason] - 覆盖 state 里记的 stopReason。
 * @returns {string} SSE 负载 JSON。
 */
export function wireFinish(state, stopReason) {
  const reason = typeof stopReason === 'string' && stopReason.length > 0 ? stopReason : state.stopReason
  const mapped = mapFinishReason(reason, state.toolOrder.length > 0)
  // 已经流出工具调用却报 stop，客户端不会去执行它们——工具循环会静默死掉。
  const finishReason = mapped.finishReason === 'stop' && state.toolOrder.length > 0
    ? 'tool_calls'
    : mapped.finishReason
  state.finishReason = finishReason
  state.closed = true
  const usage = withOutputEstimate(state.usage, state.text, state.reasoning)
  // 非流式响应在 wireFinish 之后组装，所以补齐后的 usage 必须留在 state 上，
  // 否则两条路径会报出不同的数字。
  state.usage = usage
  return chunkOf(
    state,
    state.sentRole ? {} : { role: 'assistant' },
    finishReason,
    {
      ...usage === undefined ? {} : { usage },
      ...mapped.hint === undefined ? {} : { kiro: mapped.hint },
    },
  )
}

/**
 * 补上输出侧 token 估算。
 *
 * Kiro 的 `metadataEvent.tokenUsage` 只报输入桶，输出桶常常整块缺失；报 0 会让
 * 客户端的用量面板与成本估算永远显示"没有产出"。字符数换算是唯一可用的信号，
 * 因此只在真的没有输出计数时才启用，并保留 provider 报来的值优先。
 * @param {object|undefined} usage - 已有的 usage。
 * @param {string} text - 本轮可见文本。
 * @param {string} reasoning - 本轮思考文本。
 * @returns {object|undefined} 补齐后的 usage。
 */
function withOutputEstimate(usage, text, reasoning) {
  if (usage === undefined) return undefined
  if (Number.isFinite(usage.completion_tokens) && usage.completion_tokens > 0) return usage
  const characters = (text?.length ?? 0) + (reasoning?.length ?? 0)
  if (characters === 0) return usage
  // 约 3.6 字符/token：中英混排的保守中值，宁高勿低（低估会让上下文预算虚高）。
  const estimate = Math.max(1, Math.round(characters / 3.6))
  return {
    ...usage,
    completion_tokens: estimate,
    total_tokens: (usage.prompt_tokens ?? 0) + estimate,
  }
}

/**
 * 组装非流式完整响应。
 *
 * 必须在 `wireFinish` 之后调用：finish_reason 与 usage 都是那时才确定的。
 * @param {object} state - 流式状态。
 * @returns {object} `/v1/chat/completions` 非流式响应。
 */
export function wireToOpenAiResponse(state) {
  const toolCalls = state.toolOrder.map(block => ({
    id: block.id,
    type: 'function',
    function: {
      name: block.name,
      // 空参数在 OpenAI 侧要写成 "{}"，否则客户端 JSON.parse 会失败。
      arguments: block.arguments.length > 0 ? block.arguments : '{}',
    },
  }))
  const message = {
    role: 'assistant',
    // 有工具调用时 content 必须是 null，不能是空串。
    content: state.text.length > 0 ? state.text : null,
    ...state.reasoning.length > 0 ? { reasoning_content: state.reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
  return {
    id: state.id,
    object: 'chat.completion',
    created: state.created,
    model: state.model,
    choices: [{
      index: state.index,
      message,
      finish_reason: state.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      logprobs: null,
    }],
    ...state.usage === undefined ? {} : { usage: state.usage },
  }
}
