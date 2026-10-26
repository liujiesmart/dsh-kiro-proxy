/**
 * Anthropic `/kiro-proxy/v1/messages` <-> Kiro wire 的翻译层。
 *
 * 纯函数，无 I/O。与 `kiro-openai.js` 是同一套 Kiro 语义的两个外壳，请求方向
 * 的共同部分都在 `kiro-history.js`；这里只处理 Anthropic 自己的词汇表：
 *
 * - `system` 是顶层字段（字符串或 block 数组），最终同样前置到最早的 user 轮。
 * - `content` 在流式响应里是按 index 编号的 block 流（`content_block_start` /
 *   `content_block_delta` / `content_block_stop`），所以流式侧要自己维护
 *   「当前打开的是哪个 block」。
 * - `stop_reason` 没有 `length`，上下文超限只能用 `max_tokens` 表达截断，再用
 *   附加字段说明真实原因。
 *
 * @module dsh-kiro-proxy/kiro-anthropic
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

/** Anthropic media_type -> Kiro ImageFormat。 */
const MEDIA_TYPE_TO_FORMAT = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 归一化 stopReason 便于查表（UPPER_SNAKE）。
 * @param {unknown} reason - 原始值。
 * @returns {string} 归一化结果，无值时为空串。
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
 * 解析 `tool_use.input`（以及流式里累积的 partialJson）。
 *
 * Anthropic 的 input 本来就是对象，个别客户端会序列化成字符串，两种都收；
 * 解析不了就给 `{}`，过去轮次的坏参数不影响当前请求。
 * @param {unknown} input
 * @returns {unknown}
 */
function parseToolInput(input) {
  if (isRecord(input)) return input
  if (typeof input !== 'string' || input === '') return {}
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}

/**
 * 把 Anthropic image block 转成 Kiro ImageBlock。
 *
 * 只接受 base64 source：Kiro 的 `ImageSource` 只有 `bytes`，服务端不会去下载
 * URL；静默丢弃会让用户以为图生效了，所以显式报错。
 * @param {any} block
 * @returns {{format: string, source: {bytes: string}}}
 * @throws `UNSUPPORTED_CONTENT` / `INVALID_REQUEST`。
 */
function imageFromBlock(block) {
  const source = block?.source
  if (!isRecord(source)) throw kiroError('Anthropic image block carries no source', 'INVALID_REQUEST')
  switch (source.type) {
    case 'base64':
      break
    case 'url':
      throw kiroError('Kiro cannot fetch remote images; send the image as a base64 source', 'UNSUPPORTED_CONTENT')
    default:
      throw kiroError(`Kiro does not accept image source type "${String(source.type)}"`, 'UNSUPPORTED_CONTENT')
  }
  const mediaType = typeof source.media_type === 'string' ? source.media_type.trim().toLowerCase() : ''
  const format = Object.hasOwn(MEDIA_TYPE_TO_FORMAT, mediaType) ? MEDIA_TYPE_TO_FORMAT[mediaType] : undefined
  if (format === undefined) {
    throw kiroError(`Kiro does not accept ${mediaType === '' ? 'untyped' : mediaType} images`, 'UNSUPPORTED_CONTENT')
  }
  const bytes = typeof source.data === 'string' ? source.data.replace(/\s+/g, '') : ''
  if (bytes === '') throw kiroError('Anthropic image block carries no data', 'INVALID_REQUEST')
  return { format, source: { bytes } }
}

/**
 * 读 Anthropic 的 content（字符串或 block 数组）到一个统一轮次里。
 *
 * `tool_result` 的 content 也是「字符串或 block 数组」，递归读进一个临时轮次：
 * 文本成为结果正文，图片提升到承载它的 user 轮（`ToolResultContentBlock` 只有
 * text/json，没有图片槽位）。thinking 块没有回放槽位，丢弃。
 * @param {unknown} content
 * @param {'user'|'assistant'} role
 * @param {object} turn - 输出：追加 text / toolUses / toolResults；图片进 `images`。
 * @param {object[]} images - 图片收集处（原地追加）。
 */
function readBlocks(content, role, turn, images) {
  if (content === null || content === undefined) return
  if (typeof content === 'string') {
    turn.text += content
    return
  }
  if (!Array.isArray(content)) {
    throw kiroError('Anthropic message content must be a string or an array of blocks', 'INVALID_REQUEST')
  }
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text') {
      if (typeof block.text === 'string') turn.text += block.text
    } else if (block.type === 'image') {
      if (role !== 'user') throw imageOnWrongTurn(role)
      images.push(imageFromBlock(block))
    } else if (block.type === 'tool_use') {
      // 名字等调用方拿到 map 之后再改写，这里先保存原名。
      turn.toolUses.push({
        toolUseId: toolUseIdFor(block.id),
        name: typeof block.name === 'string' ? block.name : '',
        input: parseToolInput(block.input),
      })
    } else if (block.type === 'tool_result') {
      const inner = emptyTurn(role)
      readBlocks(block.content, role, inner, images)
      turn.toolResults.push({
        toolUseId: toolUseIdFor(block.tool_use_id),
        // 空输出在 wire 上也要有内容，否则服务端按校验失败处理。
        content: [{ text: inner.text === '' ? '(no output)' : inner.text }],
        status: block.is_error === true ? 'error' : 'success',
      })
    }
    // thinking / redacted_thinking / document / search_result 等：Kiro 无对应槽位。
  }
}

/**
 * 读顶层 system（字符串或 text block 数组）。
 * @param {unknown} system
 * @returns {string}
 */
function readSystem(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return joinSystem(system.map(block => (isRecord(block) && block.type === 'text' ? block.text : undefined)))
}

// ---------------------------------------------------------------------------
// 请求方向：Anthropic -> wire
// ---------------------------------------------------------------------------

/**
 * 把一条 Anthropic 消息读成统一轮次。
 *
 * user 轮只保留文本、工具结果与图片；assistant 轮只保留文本与工具调用（工具名
 * 在这里改写成 wire 名）。
 * @param {object} message
 * @param {Map<string, string>} toolNameMap
 * @returns {object}
 */
function readTurn(message, toolNameMap) {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const scratch = emptyTurn(role)
  const images = []
  readBlocks(message.content, role, scratch, images)
  const turn = emptyTurn(role, scratch.text)
  if (role === 'assistant') {
    for (const use of scratch.toolUses) {
      turn.toolUses.push({ ...use, name: toolNameFor(use.name, toolNameMap) })
    }
  } else {
    turn.toolResults = scratch.toolResults
    turn.images = images
  }
  return turn
}

/**
 * 读 Anthropic 的 tools。`input_schema` 落到 `inputSchema.json`：Kiro 的
 * `ToolSpecification` 就是这样嵌套的。服务端工具（`web_search_20250305` 之类）
 * 没有对应实现，跳过。
 * @param {unknown} tools
 * @param {Map<string, string>} toolNameMap
 * @returns {object[]}
 */
function readTools(tools, toolNameMap) {
  if (!Array.isArray(tools)) return []
  const specs = []
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name === '') continue
    const serverTool = tool.input_schema === undefined && typeof tool.type === 'string' && tool.type !== 'custom'
    if (serverTool) continue
    specs.push({
      toolSpecification: {
        name: toolNameFor(tool.name, toolNameMap),
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: { json: isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} } },
      },
    })
  }
  return specs
}

/**
 * 把 Anthropic `/v1/messages` 请求翻译成 Kiro wire 请求。
 *
 * `tool_choice` 被忽略：wire 上没有强制选择工具的字段，写进去会被 schema 校验
 * 拒掉；客户端「必须调用工具」的意图通常由它自己的循环兜底。`temperature` /
 * `top_p` / `stop_sequences` 同理不发（见 CONTRACT 第 3 节）。
 *
 * @param {any} body - 请求体。
 * @param {{modelId?: string, conversationId?: string, profileArn?: string,
 *   systemPrefix?: string, effort?: {schemaPath: 'output_config'|'reasoning', level: string},
 *   maxTokensBounds?: {minimum: number, maximum: number},
 *   maxTokensField?: string}} ctx - 路由侧上下文。
 * @returns {{body: object, stream: boolean, model: string, toolNameMap: Map<string, string>}}
 * @throws {Error} 参数不可用时抛带 code 的 kiroError。
 */
export function anthropicToWire(body, ctx = {}) {
  const opened = openRequest(body, ctx, 'Anthropic')
  const { request } = opened
  const toolNameMap = new Map()
  const turns = []
  for (const message of opened.messages) {
    if (isRecord(message)) pushTurn(turns, readTurn(message, toolNameMap))
  }
  return finishRequest(opened, {
    turns,
    tools: readTools(request.tools, toolNameMap),
    system: joinSystem([ctx.systemPrefix, readSystem(request.system)]),
    // max_tokens 在 Anthropic 是必填项，但只有模型声明了边界时才会发出去。
    fields: generationFields(ctx, Number.isInteger(request.max_tokens) ? request.max_tokens : undefined),
    profileArn: ctx.profileArn,
    toolNameMap,
  })
}

// ---------------------------------------------------------------------------
// 响应方向：wire 事件 -> Anthropic SSE
// ---------------------------------------------------------------------------

/**
 * 建一个 Anthropic 流式状态。
 *
 * 关键字段是 `block`（当前打开的 content block）与 `queue`：Anthropic 的协议
 * 要求"关掉上一个 block 才能开下一个"，而一次 wire 事件最多只能换回一个 SSE
 * 帧，所以关/开这两帧里的一帧会排队，由下一次调用或 `anthropicStop` 排出。
 * 顺序不会乱，只是允许晚一个事件到达。
 * @param {{id?: string, model?: string}} [init] - 可选的固定值。
 * @returns {object} state。
 */
export function newAnthropicState(init = {}) {
  return {
    /** message id，客户端用它做日志关联。 */
    id: typeof init.id === 'string' && init.id.length > 0 ? init.id : `msg_${randomUUID().replace(/-/g, '')}`,
    /** 回显客户端请求的模型名。 */
    model: typeof init.model === 'string' && init.model.length > 0 ? init.model : 'kiro',
    /** 已分配的 block 数，下一个 block 的 index。 */
    nextIndex: 0,
    /** 当前打开的 block：{index, type, ...}；null 表示没有。 */
    block: null,
    /**
     * 按出现顺序记录过的全部 block，非流式响应（anthropicResponse）就靠它
     * 还原 content 数组。流式帧只带增量，客户端自己攒；服务端要回一份完整
     * 响应时没有客户端可依赖，必须在这里留一份。
     */
    blocks: [],
    /** wire toolUseId -> block（工具块要按 id 归并增量）。 */
    tools: new Map(),
    /** 待发帧队列，元素是 {event, data}。 */
    queue: [],
    /** 是否已经发过 message_start。 */
    started: false,
    /** 累积的可见文本（非流式回放与 usage 估算用）。 */
    text: '',
    /** 累积的 thinking 文本。 */
    reasoning: '',
    /** Anthropic 形态的 usage 累积。 */
    usage: { input_tokens: 0, output_tokens: 0 },
    /** 原始 stopReason，留作诊断。 */
    stopReason: null,
    /** 流内错误。 */
    error: null,
    /** 是否已经收尾。 */
    closed: false,
  }
}

/**
 * 把一帧压进队列。
 * @param {object} state - 流式状态。
 * @param {string} event - SSE event 名。
 * @param {object} payload - data 对象。
 */
function push(state, event, payload) {
  state.queue.push({ event, data: JSON.stringify(payload) })
}

/**
 * 从队列取一帧。
 * @param {object} state - 流式状态。
 * @returns {{event: string, data: string}|undefined} 帧或 undefined。
 */
function drain(state) {
  return state.queue.shift()
}

/**
 * 关掉当前打开的 block。
 *
 * Anthropic 客户端按 index 累积 block，缺 `content_block_stop` 会让 SDK 认为
 * 该 block 仍未完成，工具调用的 input 也就永远不"定稿"。
 * @param {object} state - 流式状态。
 */
function closeBlock(state) {
  if (state.block === null) return
  push(state, 'content_block_stop', { type: 'content_block_stop', index: state.block.index })
  state.block = null
}

/**
 * 打开一个 text block。
 * @param {object} state - 流式状态。
 * @returns {object} block。
 */
function openText(state) {
  if (state.block?.type === 'text') return state.block
  closeBlock(state)
  const index = state.nextIndex++
  const block = { index, type: 'text', text: '' }
  state.block = block
  // 记进 blocks 是为了非流式路径能按顺序还原完整 content。
  state.blocks.push(block)
  push(state, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
  return block
}

/**
 * 打开一个 thinking block。
 * @param {object} state - 流式状态。
 * @returns {object} block。
 */
function openThinking(state) {
  if (state.block?.type === 'thinking') return state.block
  closeBlock(state)
  const index = state.nextIndex++
  const block = { index, type: 'thinking', thinking: '', signature: '' }
  state.block = block
  state.blocks.push(block)
  push(state, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  })
  return block
}

/**
 * 打开一个 tool_use block。
 *
 * `partialJson` 是这个块自己的参数累积缓冲：流式客户端能从
 * `input_json_delta` 自己攒，但非流式路径（`anthropicResponse`）没有客户端
 * 可依赖，必须由 state 侧攒一份才能解析出 `input`。
 * @param {object} state - 流式状态。
 * @param {string} id - wire toolUseId。
 * @param {string} name - 工具名。
 * @returns {object} block。
 */
function openToolUse(state, id, name) {
  const key = id.length > 0 ? id : `tooluse_${state.nextIndex}`
  const existing = state.tools.get(key)
  if (existing !== undefined) {
    if (name.length > 0) existing.name = name
    return existing
  }
  closeBlock(state)
  const index = state.nextIndex++
  const block = { index, type: 'tool_use', toolId: key, id: key, name, partialJson: '' }
  state.tools.set(key, block)
  state.blocks.push(block)
  state.block = block
  push(state, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id: key, name, input: {} },
  })
  return block
}

/**
 * `message_start` 负载。
 *
 * 必须在任何 `content_block_*` 之前发；usage 此刻还不知道，先给 0，真实值在
 * `message_delta` 里补。
 * @param {object} state - 流式状态。
 * @returns {string} JSON 负载。
 */
export function anthropicStart(state) {
  state.started = true
  return JSON.stringify({
    type: 'message_start',
    message: {
      id: state.id,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

/**
 * 把归一化事件翻译成一个 Anthropic SSE 帧。
 *
 * 每次调用最多返回一帧；需要关/开两个 block 时，第二帧留在 `state.queue`，
 * 由下一次调用或 `anthropicStop` 排出（顺序保证不变）。
 * @param {{kind: string} & Record<string, unknown>} evt - kiro-client 归一化后的事件。
 * @param {object} state - `newAnthropicState` 的返回值。
 * @returns {{event: string, data: string}|undefined} 帧或 undefined。
 */
export function wireToAnthropicEvent(evt, state) {
  if (evt === null || typeof evt !== 'object') return drain(state)
  switch (evt.kind) {
    case 'text': {
      const text = typeof evt.text === 'string' ? evt.text : ''
      if (text.length === 0) break
      state.text += text
      const block = openText(state)
      // 块自己也要攒：非流式响应直接读 blocks，不再回放帧。
      block.text += text
      push(state, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'text_delta', text },
      })
      break
    }
    case 'reasoning': {
      const text = typeof evt.text === 'string' ? evt.text : ''
      if (text.length === 0) break
      state.reasoning += text
      const block = openThinking(state)
      block.thinking += text
      push(state, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'thinking_delta', thinking: text },
      })
      break
    }
    case 'tool-start': {
      const block = openToolUse(
        state,
        typeof evt.id === 'string' ? evt.id : '',
        typeof evt.name === 'string' ? evt.name : '',
      )
      state.block = block
      break
    }
    case 'tool-delta': {
      const id = typeof evt.id === 'string' ? evt.id : ''
      const fragment = typeof evt.argumentsDelta === 'string' ? evt.argumentsDelta : ''
      let block = state.tools.get(id)
      if (block === undefined) {
        // 没见过 start 就来片段：惰性建块，id/name 与首段参数同帧带出。
        block = openToolUse(state, id, '')
      }
      state.block = block
      // 累积到块上：非流式路径靠这段 partialJson 解析 input。
      block.partialJson += fragment
      if (fragment.length > 0) {
        push(state, 'content_block_delta', {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: fragment },
        })
      }
      break
    }
    case 'tool-stop': {
      // 只有关掉块，客户端才会把累积的 partial_json 解析成 input。
      const block = state.tools.get(typeof evt.id === 'string' ? evt.id : '')
      if (block !== undefined) {
        state.block = block
        closeBlock(state)
      }
      break
    }
    case 'usage': {
      state.usage = anthropicUsage(evt, state.usage)
      break
    }
    case 'stop': {
      state.stopReason = typeof evt.stopReason === 'string' ? evt.stopReason : null
      break
    }
    case 'error': {
      // 流已经开始，抛错只会让客户端看到断流。按 Anthropic 的惯例发一个 error
      // 事件：SDK 会把它当本轮失败，但连接与已有内容都保住了。
      state.error = {
        message: typeof evt.message === 'string' && evt.message.length > 0
          ? evt.message
          : 'Kiro stream failed',
        code: typeof evt.code === 'string' && evt.code.length > 0 ? evt.code : 'UPSTREAM_ERROR',
      }
      state.closed = true
      push(state, 'error', { type: 'error', error: { type: 'api_error', message: state.error.message } })
      break
    }
    default:
      // 未知事件绝不当作正文吐出去。
      break
  }
  return drain(state)
}

/**
 * 把 Kiro 的四个互斥桶映射成 Anthropic usage。
 *
 * `cache_read_input_tokens` / `cache_creation_input_tokens` 是 Anthropic 自己的
 * 缓存口径，与 Kiro 的 cacheRead/cacheWrite 一一对应，直接照搬。
 * @param {any} evt - usage 事件。
 * @param {{input_tokens: number, output_tokens: number}} current - 已有 usage。
 * @returns {object} 新的 usage。
 */
function anthropicUsage(evt, current) {
  const input = Number.isFinite(evt.inputTokens) ? Math.max(0, evt.inputTokens) : current.input_tokens
  const output = Number.isFinite(evt.outputTokens) ? Math.max(0, evt.outputTokens) : current.output_tokens
  const cacheRead = Number.isFinite(evt.cacheReadTokens) ? Math.max(0, evt.cacheReadTokens) : undefined
  const cacheWrite = Number.isFinite(evt.cacheWriteTokens) ? Math.max(0, evt.cacheWriteTokens) : undefined
  return {
    input_tokens: input,
    output_tokens: output,
    ...cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cache_creation_input_tokens: cacheWrite },
  }
}

/**
 * stopReason -> Anthropic stop_reason。
 *
 * 单独抽出来是因为 message_delta 与非流式回放必须给同一个答案。注意
 * `MODEL_CONTEXT_WINDOW_EXCEEDED`：Anthropic 的词汇表里没有 `length`，只能用
 * `max_tokens` 表达"被预算截断"，再用 `kiro` 附加字段说明真实原因。
 * @param {unknown} stopReason - 原始 stopReason。
 * @param {boolean} hasTools - 本轮是否真的发出过工具调用。
 * @returns {{stopReason: string, hint?: object}} stop_reason 与可选诊断。
 */
function mapStopReason(stopReason, hasTools) {
  switch (normalizeStopReason(stopReason)) {
    case 'END_TURN':
    case 'STOP':
    case 'STOP_SEQUENCE':
      return { stopReason: 'end_turn' }
    case 'TOOL_USE':
    case 'TOOL_CALLS':
      return { stopReason: 'tool_use' }
    case 'MAX_TOKENS':
    case 'MAX_OUTPUT_TOKENS':
    case 'LENGTH':
      return { stopReason: 'max_tokens' }
    case 'MODEL_CONTEXT_WINDOW_EXCEEDED':
    case 'CONTEXT_WINDOW_EXCEEDED':
      return {
        stopReason: 'max_tokens',
        hint: {
          code: 'MODEL_CONTEXT_WINDOW_EXCEEDED',
          message: 'Kiro stopped the turn because the model context window was exceeded',
        },
      }
    case 'CONTENT_FILTERED':
    case 'REFUSAL':
      return { stopReason: 'end_turn' }
    case 'PAUSE_TURN':
      return { stopReason: 'end_turn' }
    default:
      // 未知或缺失：按已经产出了什么收尾，绝不吞内容。
      return { stopReason: hasTools ? 'tool_use' : 'end_turn' }
  }
}

/**
 * 收尾：关掉打开的 block，发 `message_delta` 与 `message_stop`。
 *
 * 返回数组而不是单帧，是因为这里要一次性把队列里剩下的帧（包括被推迟的
 * `content_block_stop`）全部排出，再补上收尾两帧。
 * @param {object} state - 流式状态。
 * @param {string} [stopReason] - 覆盖 state 里记的 stopReason。
 * @returns {{event: string, data: string}[]} 依次要写的 SSE 帧。
 */
export function anthropicStop(state, stopReason) {
  if (state.closed && state.queue.length === 0) return []
  const resolved = resolveStop(state, stopReason)
  closeBlock(state)
  push(state, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: resolved.stopReason, stop_sequence: null },
    usage: state.usage,
    ...resolved.hint === undefined ? {} : { kiro: resolved.hint },
  })
  push(state, 'message_stop', { type: 'message_stop' })
  state.stopReason = resolved.raw
  state.closed = true
  const frames = state.queue
  state.queue = []
  return frames
}

/**
 * 解出最终 stop_reason。
 *
 * `anthropicStop` 与 `anthropicResponse` 必须给同一个答案，否则同一个请求在
 * 流式与非流式两条路径上会报不同的 stop_reason，客户端的分支逻辑会不一致。
 * @param {object} state - 流式状态。
 * @param {string} [stopReason] - 覆盖 state 里记的 stopReason。
 * @returns {{raw: string|null, stopReason: string, hint?: object}} 解出的结果。
 */
function resolveStop(state, stopReason) {
  const raw = typeof stopReason === 'string' && stopReason.length > 0 ? stopReason : state.stopReason
  const mapped = mapStopReason(raw, state.tools.size > 0)
  // 已经流过工具调用却报 end_turn，客户端不会去执行它们——工具循环会静默死掉。
  const stop = mapped.stopReason === 'end_turn' && state.tools.size > 0
    ? 'tool_use'
    : mapped.stopReason
  return {
    raw: raw ?? null,
    stopReason: stop,
    ...mapped.hint === undefined ? {} : { hint: mapped.hint },
  }
}

/**
 * 组装非流式完整响应（`/v1/messages` 非流式路径）。
 *
 * 必须在 `anthropicStop` 之后调用：stop_reason 与 usage 那时才确定。若提前调用
 * 也能工作——stop_reason 按 state 里已有的 stopReason 推导，缺省值就是
 * `end_turn`。
 *
 * content 按 block 的出现顺序还原，而不是按 type 分组：Anthropic 的客户端与
 * 上游回放逻辑都假定 content 的顺序就是模型产出的顺序，thinking / text /
 * tool_use 交错时分组会打乱语义。
 * @param {object} state - `newAnthropicState` 的返回值。
 * @returns {object} Anthropic Messages 响应对象。
 */
export function anthropicResponse(state) {
  const resolved = resolveStop(state, undefined)
  const content = []
  for (const block of state.blocks) {
    if (block.type === 'text') {
      // 空文本块没有信息量；整体为空时下面再补一个，避免中间混进空块。
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'thinking') {
      if (block.thinking.length > 0) {
        content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' })
      }
      continue
    }
    if (block.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        // 解析失败给 {}：半截 JSON 是模型被截断时的常态，让它把整个响应炸掉
        // 不如让工具调用带着空参数进去，客户端自己能报参数校验错误。
        input: parseToolInput(block.partialJson),
      })
    }
  }
  // Anthropic 不允许 content 为空数组：一个被过滤的空轮也要有可读的块。
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return {
    id: state.id,
    type: 'message',
    role: 'assistant',
    model: state.model,
    content,
    stop_reason: resolved.stopReason,
    stop_sequence: null,
    usage: state.usage,
    ...resolved.hint === undefined ? {} : { kiro: resolved.hint },
  }
}
