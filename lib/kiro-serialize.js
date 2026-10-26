/**
 * 把 Harness 的 `GenerateOptions` 序列化成 Kiro `generateAssistantResponse`
 * 的请求体。
 *
 * 这个 wire 操作有三个性质决定了整个翻译的形状：
 *
 * - 没有 system 槽。system prompt 只能前置到最早一条 user 内容里，否则整段
 *   人设会丢——服务端不会报错，只会当它不存在。
 * - 最后一轮 user 是 `currentMessage` 而不是 history 条目，且
 *   `conversationState.history` 必须严格 user/assistant 交替。缺口只能补中性
 *   文本；补「像系统消息」的标记会被模型模仿并当成可见输出吐回来。
 * - 工具结果不是独立角色，而是承载它的那条 user 消息的
 *   `userInputMessageContext.toolResults`；服务端会拒绝引用不存在 toolUseId
 *   的结果，所以配不上的结果降级成文本，而不是让整个请求 400。
 *
 * 交替与补位规则和反代侧共用 `kiro-history.js`；折叠与字符预算是 Host 路由
 * 独有的策略，留在这里。
 *
 * @module dsh-kiro-proxy/kiro-serialize
 */

import { kiroError } from './kiro-error.js'
import {
  PADDING,
  TOOL_NAME_PATTERN,
  TOOL_USE_ID_PATTERN,
  acknowledgement,
  alternate,
  appendToolResults,
  describeToolUse,
  emptyTurn,
  hashToolName,
  hashToolUseId,
  isRecord,
  issuedToolUseIds,
  pushTurn,
  toolResultAsText,
  userInput,
} from './kiro-history.js'

/**
 * history 条目数上限。按条数而不是 token 限制：超过之后服务端一律回
 * `Input is too long.`，与 token 数无关。
 */
const MAX_HISTORY_ENTRIES = 198
/**
 * 一次折叠吃掉多少条。不是「超一条折一条」：每次折叠都会让服务端的前缀缓存
 * 从折叠点开始全部失效，折得越碎越贵；按块折叠则是每块只 miss 一次。
 * 取值 150 让折叠后留下约 50 条结构化轮次，够模型接住最近上下文。
 */
const FOLD_BLOCK = 150
/** 折叠的目标保留条数，固定为偶数，保证折叠边界落在 assistant 上。 */
const FOLD_KEEP = MAX_HISTORY_ENTRIES - 2
/**
 * 单次请求的字符预算。
 *
 * Kiro 只回一句 `Input is too long.`，不给数字；条目数上限（198）管不住这种情况 ——
 * 一个回合里几十条工具结果就能把报文推到几 MB，而条目数远没到上限。所以除了
 * 条目数，还要按"实际要发多少字符"兜一层。
 */
const DEFAULT_MAX_REQUEST_CHARS = 320_000
/** 单条工具结果保留的字符数：超长输出对模型没用，只会把窗口挤爆。 */
const TOOL_RESULT_CHAR_LIMIT = 20_000
/** 其他长文本（用户粘贴、assistant 长回答）单条上限。 */
const TURN_TEXT_CHAR_LIMIT = 60_000
/** 折叠产物的前缀，让模型知道这段是被压缩过的更早上下文。 */
const FOLD_PREFIX = '[earlier conversation]\n'
/** wire 的 ImageFormat 枚举，别的格式服务端直接拒。 */
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp'])
/** `additionalModelRequestFields` 里能承载 effort 的两个槽位。 */
const EFFORT_SLOTS = new Set(['output_config', 'reasoning'])

/**
 * 把任意 tool-call id 映射成 Kiro 接受的形式。
 *
 * 必须是确定性的：同一个 call 和它的 result 要能重新配对，重放的历史前缀也要
 * 保持稳定（否则每次请求都 miss 前缀缓存）。
 * @param {string} id - harness 侧的 tool-call id。
 * @returns {string} 合法 id，或 `tooluse_` + sha256 base64url 前 32 位。
 */
export function wireToolUseId(id) {
  const raw = typeof id === 'string' ? id : String(id ?? '')
  return TOOL_USE_ID_PATTERN.test(raw) ? raw : hashToolUseId(raw)
}

/**
 * 造一个「harness 工具名 -> wire 工具名」的改名器，并把改名记进 map。
 *
 * 非法名不能直接抛：harness 允许任意名字（`mcp__fs/read`、`web.search`），
 * 而 Kiro 只认 `[A-Za-z][A-Za-z0-9_]{0,63}`。改名 + 记录才能让回程把
 * toolUse 还原成 harness 认识的名字。
 * @param {object} ctx - 序列化上下文。
 * @param {Map<string,string>} map - 输出：wire 名 -> harness 名。
 * @returns {(name: string) => string} 改名器。
 */
function makeToolNamer(ctx, map) {
  const custom = typeof ctx.toolNameMap === 'function' ? ctx.toolNameMap : undefined
  if (ctx.toolNameMap instanceof Map) {
    for (const [wire, harness] of ctx.toolNameMap) map.set(wire, harness)
  }
  return (name) => {
    const raw = typeof name === 'string' ? name : String(name ?? '')
    let wire = raw
    if (custom !== undefined) {
      // 调用方可以自己决定改名规则（例如保留可读前缀）；只有结果合法才采用。
      const candidate = String(custom(raw) ?? '')
      if (TOOL_NAME_PATTERN.test(candidate)) wire = candidate
    }
    // sha1 前 12 位：足够避撞，又短到不会挤占 description 的注意力。
    if (!TOOL_NAME_PATTERN.test(wire)) wire = hashToolName(raw)
    // 恒等映射不写进 map：回程 `map.get(name) ?? name` 已经覆盖这种情况，
    // 塞满同名键只会让状态 API 的调试输出变得难读。
    if (wire !== raw && !map.has(wire)) map.set(wire, raw)
    return wire
  }
}

/**
 * 拼接一条消息里的 text 块。
 * @param {ReadonlyArray<{type?: string, text?: string}>} blocks - 内容块。
 * @returns {string} 拼接后的文本，reasoning 与 file 块被丢弃。
 */
function flattenText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * 判断一条消息是否带图片块。
 * @param {ReadonlyArray<{type?: string}>} blocks - 内容块。
 * @returns {boolean} 是否含 image 块。
 */
function hasImage(blocks) {
  return Array.isArray(blocks) && blocks.some((block) => block?.type === 'image')
}

/**
 * 归一化图片格式。
 * @param {unknown} format - ctx.images 里给的格式，可能是 `png` 或 `image/png`。
 * @returns {'png'|'jpeg'|'gif'|'webp'|undefined} wire 枚举值。
 */
function normalizeImageFormat(format) {
  const raw = String(format ?? '').toLowerCase()
  const bare = raw.startsWith('image/') ? raw.slice('image/'.length) : raw
  const alias = bare === 'jpg' ? 'jpeg' : bare
  return IMAGE_FORMATS.has(alias) ? alias : undefined
}

/**
 * 按内容顺序收集一条 user 消息的 wire 图片。
 *
 * 图片只能挂在 user 轮上：`ToolResultContentBlock` 是 text/json 的联合，没有
 * 图片座位。所以工具结果里的图片也走这里，随承载它的 user 轮一起上 wire。
 * @param {ReadonlyArray<{type?: string, attachment?: {attachmentId?: string}}>} blocks
 * @param {Map<string, {format: string, source: {bytes: string}}>} prepared - ctx.images。
 * @returns {Array<{format: string, source: {bytes: string}}>} wire 图片块。
 * @throws `UNSUPPORTED_CONTENT` 当 ctx 没提供这张图（宁可报错也不静默丢图）。
 */
function imagesOf(blocks, prepared) {
  const images = []
  if (!Array.isArray(blocks)) return images
  for (const block of blocks) {
    if (block?.type !== 'image') continue
    const attachmentId = block.attachment?.attachmentId
    const preparedImage = attachmentId === undefined ? undefined : prepared.get(attachmentId)
    if (preparedImage === undefined) {
      throw kiroError(
        `Kiro request image ${String(attachmentId)} was not prepared`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const format = normalizeImageFormat(preparedImage.format)
    const bytes = preparedImage.source?.bytes
    if (format === undefined || typeof bytes !== 'string') {
      throw kiroError(
        `Kiro request image ${String(attachmentId)} has unusable format "${String(preparedImage.format)}"`,
        'UNSUPPORTED_CONTENT',
      )
    }
    images.push({ format, source: { bytes } })
  }
  return images
}

/**
 * 校验 assistant 轮没有图片。
 *
 * assistant 消息在 wire 上只有 content 与 toolUses 两个成员，图片没有座位；
 * 静默丢弃会让模型的历史与真实对话不一致，所以直接拒绝。
 * @param {ReadonlyArray<{type?: string}>} blocks - 内容块。
 * @throws `UNSUPPORTED_CONTENT` 当 assistant 轮带图片。
 */
function assertNoImages(blocks) {
  if (hasImage(blocks)) {
    throw kiroError(
      'Kiro accepts images only on user turns; this request has one on an assistant turn',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * 解析 tool-call 的参数字符串。
 * @param {unknown} raw - 模型产出的原始 JSON 字符串。
 * @returns {unknown} 解析结果；空串或非法 JSON 一律给 `{}`。
 */
function parseArguments(raw) {
  const text = typeof raw === 'string' ? raw : ''
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    // 重放历史不能因为过去某次调用的坏参数而失败整条请求。
    return {}
  }
}

/**
 * 构造一条 tool result。
 * @param {object} message - harness 的 tool 角色消息。
 * @returns {{toolUseId: string, content: Array<{text: string}>, status: 'success'|'error'}}
 */
function toolResultOf(message) {
  // 空输出也要有内容，否则 wire 校验失败。
  const output = flattenText(message.content) || '(no output)'
  const failed = message.isError === true
  return { toolUseId: wireToolUseId(message.toolCallId), content: [{ text: output }], status: failed ? 'error' : 'success' }
}

/**
 * 把一条 assistant 消息的 tool-call 块转成 wire toolUses。
 * @param {ReadonlyArray<object>} blocks - 内容块。
 * @param {(name: string) => string} rename - 工具改名器。
 * @returns {Array<{toolUseId: string, name: string, input: unknown}>}
 */
function toolUsesOf(blocks, rename) {
  if (!Array.isArray(blocks)) return []
  return blocks
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({
      toolUseId: wireToolUseId(block.id),
      name: rename(block.name),
      // Kiro 要的是已解析对象，harness 给的是模型原始 JSON 字符串。
      input: parseArguments(block.arguments),
    }))
}

/**
 * 把 harness 消息读成 user/assistant 交替的轮次。
 *
 * 连续同角色就地合并：harness 的一轮里常出现「user 文本 + tool 结果」这种被拆成
 * 两条消息的形态，而 Kiro 只接受严格交替。tool 结果、system、developer 都落进
 * user 轮：Kiro 没有 system 槽，也没有 tool 角色；developer 的工具变更内容本来
 * 就是空串。
 * @param {ReadonlyArray<object>} messages - harness 会话，按顺序。
 * @param {Map<string, {format: string, source: {bytes: string}}>} prepared - ctx.images。
 * @param {(name: string) => string} rename - 工具改名器。
 * @returns {Array<object>} 轮次列表。
 */
function collectTurns(messages, prepared, rename) {
  const turns = []
  for (const message of messages) {
    if (!isRecord(message)) continue
    let turn
    if (message.role === 'assistant') {
      assertNoImages(message.content)
      turn = emptyTurn('assistant', flattenText(message.content))
      turn.toolUses = toolUsesOf(message.content, rename)
    } else if (message.role === 'tool') {
      turn = emptyTurn('user')
      turn.toolResults.push(toolResultOf(message))
      turn.images = imagesOf(message.content, prepared)
    } else {
      turn = emptyTurn('user', flattenText(message.content))
      turn.images = imagesOf(message.content, prepared)
    }
    pushTurn(turns, turn)
  }
  return turns
}

/**
 * 超过上限时把最旧的若干条 history 折成一条文本 user 轮 + 一条 assistant 占位。
 *
 * 只改结构、不丢内容：决定会话里到底该留什么属于 harness 的 compaction。
 * 按 FOLD_BLOCK 的整数倍折叠（折得越碎，前缀缓存失效越频繁），条数取偶数，
 * 这样折叠后紧跟的仍是 user 轮，交替关系原样保持。
 * @param {Array<object>} history - 以 user 开头、assistant 结尾的交替 history，原地修改。
 * @param {string} modelId - 折叠出来的 user 轮的 modelId。
 */
function foldOverflow(history, modelId) {
  if (history.length - MAX_HISTORY_ENTRIES <= 0) return
  const blocks = Math.ceil((history.length - FOLD_KEEP) / FOLD_BLOCK)
  const even = n => n + (n % 2)
  // 至少留两条（折叠轮 + 占位轮），否则等于把整段历史清空。
  const count = Math.min(even(blocks * FOLD_BLOCK), history.length - 2)
  const transcript = []
  const carriedImages = []
  for (let index = 0; index < count; index += 1) {
    const { userInputMessage: user, assistantResponseMessage: reply } = history[index]
    if (user === undefined) {
      transcript.push(`Assistant: ${reply.content}`, ...(reply.toolUses ?? []).map(describeToolUse))
      continue
    }
    transcript.push(`User: ${user.content}`, ...(user.userInputMessageContext?.toolResults ?? []).map(toolResultAsText))
    // 被折叠的 user 轮如果带图，把图挪到折叠轮上：折叠轮本身是 user 轮，
    // 图片有合法座位；丢掉它们等于让模型再也看不到用户发过的截图。
    if (user.images !== undefined) carriedImages.push(...user.images)
  }
  const folded = { ...emptyTurn('user', FOLD_PREFIX + transcript.join('\n\n')), images: carriedImages }
  history.splice(0, count, { userInputMessage: userInput(modelId, folded) }, acknowledgement())
}

/**
 * 把一条 wire user 消息里引用了未知调用的工具结果降级成正文。
 *
 * 服务端会拒绝引用未知 toolUseId 的结果；降级之后模型的观测还在，请求也不会
 * 失败。没剩下任何结果时，空的 context 一并删掉。
 * @param {object} message - `userInputMessage`，原地修改。
 * @param {Set<string>} issued - 仍在 wire 上的 assistant 轮发过的所有 toolUseId。
 */
function demoteOrphans(message, issued) {
  const context = message.userInputMessageContext
  const results = context?.toolResults
  if (!Array.isArray(results) || results.length === 0) return
  const kept = []
  const orphaned = []
  for (const result of results) (issued.has(result.toolUseId) ? kept : orphaned).push(result)
  if (orphaned.length === 0) return
  if (kept.length > 0) {
    context.toolResults = kept
  } else {
    delete context.toolResults
    if (Object.keys(context).length === 0) delete message.userInputMessageContext
  }
  message.content = appendToolResults(message.content, orphaned)
}

/**
 * 截断一段过长文本，保留头尾。
 *
 * 保留尾部是有意的：命令输出、日志、diff 的结论通常在最后。
 * @param {unknown} text - 原始文本。
 * @param {number} limit - 字符上限。
 * @returns {string} 可能被截断的文本。
 */
function clipText(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = Math.floor(limit * 0.2)
  const dropped = text.length - head - tail
  return `${text.slice(0, head)}\n…[dsh-kiro-proxy: ${dropped} chars truncated]…\n${text.slice(-tail)}`
}

/**
 * 把一条 wire 消息里的超长文本压到上限。
 * @param {object} message - `userInputMessage` 或 `assistantResponseMessage` 的内容对象。
 */
function clipMessage(message) {
  if (typeof message.content === 'string') {
    message.content = clipText(message.content, TURN_TEXT_CHAR_LIMIT)
  }
  for (const result of message.userInputMessageContext?.toolResults ?? []) {
    if (!Array.isArray(result.content)) continue
    for (const block of result.content) {
      if (typeof block?.text === 'string') block.text = clipText(block.text, TOOL_RESULT_CHAR_LIMIT)
    }
  }
}

/**
 * 把报文压进预算。
 *
 * 顺序是"先丢最旧的整轮，再裁超长文本"：丢整轮保持角色交替、语义最完整；
 * 单条裁剪只在丢掉历史还压不住时才做，因为它会伤到当前轮的观测。
 * @param {object} body - 待发送请求，原地修改。
 * @param {number} budget - 字符预算。
 * @param {string} system - system 文本（用于丢弃后重新挂载）。
 */
function enforceBudget(body, budget, system) {
  const fits = () => JSON.stringify(body).length <= budget
  if (fits()) return
  const state = body.conversationState
  const history = Array.isArray(state.history) ? state.history : []
  const current = state.currentMessage.userInputMessage
  const earliestUser = () => history.find((entry) => entry.userInputMessage !== undefined)?.userInputMessage ?? current

  // 一次丢一对（user + assistant），交替关系不会被打断。
  while (history.length > 2 && !fits()) history.splice(0, 2)
  if (!fits()) {
    for (const entry of history) clipMessage(entry.userInputMessage ?? entry.assistantResponseMessage)
    clipMessage(current)
  }

  // 丢轮会带走两样东西，两样都必须补回来，否则请求会 400：
  //   1) 那份挂在最早 user 轮上的 system prompt；
  //   2) 被丢掉的 assistant 轮发过的 toolUseId —— 它们的工具结果不能再被引用。
  if (system.length > 0) {
    const target = earliestUser()
    if (typeof target.content === 'string' && !target.content.includes(system)) {
      target.content = system + '\n\n' + target.content
    }
  }
  const issued = issuedToolUseIds(history)
  for (const entry of history) {
    if (entry.userInputMessage !== undefined) demoteOrphans(entry.userInputMessage, issued)
  }
  demoteOrphans(current, issued)

  // 最后手段：system 本身也可能过长，只保留前面一段。
  if (!fits() && system.length > 0) {
    earliestUser().content = `${system.slice(0, Math.floor(budget / 4))}\n…[dsh-kiro-proxy: system prompt truncated]…`
  }
}

/**
 * 把 system 文本解析成字符串。
 * @param {unknown} system - `options.system`，通常是字符串，也可能是一组块。
 * @returns {string} system 文本，没有则为空串。
 */
function systemText(system) {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return flattenText(system)
  return ''
}

/**
 * 构造 `additionalModelRequestFields`。
 *
 * 这是 `generateAssistantResponse` 唯一接受生成控制的地方：请求体只有
 * conversationState / profileArn / agentMode / additionalModelRequestFields /
 * systemPrompt，顶层 `inferenceConfig` 会被服务端静默丢弃。该对象按模型声明
 * 的 schema 校验（`additionalProperties: false`），所以不能投机性地塞字段：
 * 没有 effort、或者 maxTokens 没有已知上下界时，一律不发。
 * @param {object} ctx - 序列化上下文。
 * @param {object} options - harness 请求。
 * @returns {Record<string, unknown>|undefined} 要发的对象，或 undefined。
 */
function buildModelRequestFields(ctx, options) {
  /** @type {Record<string, unknown>} */
  const fields = {}
  const { effort, maxTokensBounds: bounds } = ctx
  const effortUsable = effort !== undefined && effort !== null
    && typeof effort.level === 'string' && EFFORT_SLOTS.has(effort.schemaPath)
  if (effortUsable) fields[effort.schemaPath] = { effort: effort.level }

  const requested = options.maxTokens
  const boundsKnown = bounds !== undefined && bounds !== null
    && Number.isFinite(bounds.minimum) && Number.isFinite(bounds.maximum)
  if (boundsKnown && Number.isFinite(requested) && requested > 0) {
    // 夹到声明区间里而不是丢弃：字段有下界也有上界，越界同样是 400。
    fields.max_tokens = Math.min(bounds.maximum, Math.max(bounds.minimum, Math.trunc(requested)))
  }
  if (Object.keys(fields).length > 0) return fields
  return undefined
}

/**
 * 把 harness 的工具声明转成 wire toolSpecification。
 * @param {unknown} tools - `options.tools`。
 * @param {(name: string) => string} rename - 工具改名器。
 * @returns {object[]}
 */
function toolSpecsOf(tools, rename) {
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => ({
    toolSpecification: {
      name: rename(tool?.name),
      description: typeof tool?.description === 'string' ? tool.description : '',
      inputSchema: {
        json: tool?.parameters !== null && typeof tool?.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      },
    },
  }))
}

/**
 * 序列化一次请求。
 * @param {object} options - harness 的 `GenerateOptions`。
 * @param {object} ctx - `{ conversationId, modelId, profileArn?, effort?,
 *   maxTokensBounds?, images?, toolNameMap? }`。
 * @returns {{body: object, toolNameMap: Map<string,string>}} 请求体与「wire 名 -> harness 名」映射。
 * @throws kiroError `INVALID_REQUEST` 没有任何消息；`UNSUPPORTED_CONTENT`
 *   图片无法落到 user 轮。
 */
export function serializeRequest(options, ctx) {
  const request = options ?? {}
  const context = ctx ?? {}
  const messages = Array.isArray(request.messages) ? request.messages : []
  if (messages.length === 0) {
    throw kiroError('Kiro requires at least one message', 'INVALID_REQUEST')
  }
  const { modelId } = context
  const prepared = context.images instanceof Map ? context.images : new Map()
  /** @type {Map<string,string>} */
  const toolNameMap = new Map()
  const rename = makeToolNamer(context, toolNameMap)

  const turns = collectTurns(messages, prepared, rename)
  // 最后一轮是 assistant（会话恢复、压缩边界）时补一条中性 user 轮，让请求有东西可答。
  if (turns.length > 0 && turns[turns.length - 1].role === 'assistant') {
    turns.push(emptyTurn('user', PADDING.continue))
  }
  const current = turns.pop()
  if (current?.role !== 'user') {
    throw kiroError('Kiro request has no user turn to answer', 'INVALID_REQUEST')
  }

  const history = alternate(turns, modelId)
  foldOverflow(history, modelId)

  // 折叠之后再统计「服务端见过的调用」：被折掉的 assistant 轮已经不在 wire 上，
  // 它们发出的 toolUseId 也就不能再被引用，对应的结果必须降级成文本。
  const issued = issuedToolUseIds(history)
  for (const entry of history) {
    if (entry.userInputMessage !== undefined) demoteOrphans(entry.userInputMessage, issued)
  }
  const answered = current.toolResults.filter((result) => issued.has(result.toolUseId))
  const unanswered = current.toolResults.filter((result) => !issued.has(result.toolUseId))

  const tools = toolSpecsOf(request.tools, rename)
  let turnContext
  if (tools.length > 0 || answered.length > 0) {
    turnContext = {}
    if (tools.length > 0) turnContext.tools = tools
    if (answered.length > 0) turnContext.toolResults = answered
  }
  const currentMessage = userInput(
    modelId,
    { text: appendToolResults(current.text, unanswered), toolResults: answered, images: current.images },
    turnContext,
  )

  const system = systemText(request.system)
  if (system.length > 0) {
    // Kiro 没有 system 槽：prompt 只能挂在最早一条 user 内容前面，才能既在
    // 上下文最前端、又留在可缓存前缀里。折叠之后再挂，落点才是真正的最早轮。
    const target = history.find((entry) => entry.userInputMessage !== undefined)?.userInputMessage ?? currentMessage
    target.content = system + '\n\n' + target.content
  }

  const body = {}
  if (context.profileArn !== undefined) body.profileArn = context.profileArn
  const additionalModelRequestFields = buildModelRequestFields(context, request)
  if (additionalModelRequestFields !== undefined) body.additionalModelRequestFields = additionalModelRequestFields
  const conversationState = {
    chatTriggerType: 'MANUAL',
    conversationId: context.conversationId,
    currentMessage: { userInputMessage: currentMessage },
  }
  if (history.length > 0) conversationState.history = history
  body.conversationState = conversationState

  // 最后一道闸：条目数上限管不住"一个回合里几十条巨型工具结果"，这里按字符兜底。
  const budget = Number.isInteger(context.maxRequestChars) && context.maxRequestChars > 0
    ? context.maxRequestChars
    : DEFAULT_MAX_REQUEST_CHARS
  enforceBudget(body, budget, system)
  return { body, toolNameMap }
}
