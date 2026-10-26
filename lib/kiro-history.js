/**
 * OpenAI / Anthropic 两个反代翻译层共用的 Kiro 会话组装。
 *
 * 两个外壳只负责把各自的消息词汇表读成统一的「轮次」：
 * `{ role, text, toolUses, toolResults, images }`。之后的事情两边完全一样：
 *
 * - Kiro 的 history 必须严格 user/assistant 交替，最后一轮 user 走
 *   `currentMessage`；缺口用中性口语补齐。
 * - history 条目数有硬上限，超出时按整块折叠成一段文本转述。
 * - 服务端不接受引用它没见过的 toolUseId 的工具结果，这类结果降级成正文。
 * - 没有 system 槽，system 文本前置到最早的 user 内容。
 *
 * Host 侧的 `kiro-serialize.js` 有自己的折叠与预算策略，只复用这里的协议常量
 * 与 id / 名字映射。
 *
 * @module dsh-kiro-proxy/kiro-history
 */

import { createHash, randomUUID } from 'node:crypto'

import { kiroError } from './kiro-error.js'

/** Kiro 用来归因 IDE 流量的 origin。 */
export const ORIGIN = 'AI_EDITOR'

/**
 * 补位文本。都是普通口语：带「系统标记」味道的占位会被模型学去当成可见输出。
 * - `continue`：缺失的 user 轮；
 * - `acknowledge`：缺失的 assistant 轮，或只有工具调用、没有散文的 assistant 轮；
 * - `toolResultsOnly`：只携带工具结果的 user 轮（wire 上 content 不能为空）。
 */
export const PADDING = Object.freeze({
  continue: 'Continue',
  acknowledge: 'understood',
  toolResultsOnly: 'Tool results provided.',
})

/** Kiro 原样接受的工具名：字母开头，其后最多 63 个单词字符。 */
export const TOOL_NAME_PATTERN = /^[A-Za-z]\w{0,63}$/
/** Kiro 原样接受的 toolUseId：1–64 个单词字符或连字符。 */
export const TOOL_USE_ID_PATTERN = /^[\w-]{1,64}$/

/**
 * history 条目上限：超过之后服务端一律回 `Input is too long.`，与 token 数无关。
 */
const MAX_HISTORY_ENTRIES = 198
/** 折叠粒度。整块折叠让前缀缓存每块只失效一次；150 是偶数，交替关系不变。 */
const FOLD_BLOCK = 150
/** 折叠后至少要留下的结构化条目：一条折叠轮 + 一条补位。 */
const FOLD_RESERVE = 2

/**
 * @param {unknown} value
 * @returns {value is object} 非 null 的对象（含数组）。
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object'
}

/**
 * @param {unknown} value
 * @returns {value is string} 非空字符串。
 */
export function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * 截取一段摘要哈希。
 * @param {'sha1'|'sha256'} algorithm
 * @param {string} input
 * @param {'hex'|'base64url'} encoding
 * @param {number} length - 保留的前缀长度。
 * @returns {string}
 */
function digestPrefix(algorithm, input, encoding, length) {
  const hash = createHash(algorithm)
  hash.update(input)
  return hash.digest(encoding).slice(0, length)
}

/**
 * 不合法 toolUseId 的确定性替身：同一个 id 永远映射到同一个值，调用与结果
 * 才能重新配对，重放的历史前缀也才能保持字节稳定。
 * @param {string} raw
 * @returns {string} `tooluse_` + sha256 base64url 前 32 位。
 */
export function hashToolUseId(raw) {
  return 'tooluse_' + digestPrefix('sha256', raw, 'base64url', 32)
}

/**
 * 不合法工具名的确定性替身。
 * @param {string} raw
 * @returns {string} `tool_` + sha1 hex 前 12 位。
 */
export function hashToolName(raw) {
  return 'tool_' + digestPrefix('sha1', raw, 'hex', 12)
}

/**
 * 反代侧的 toolUseId 映射：非字符串一律按空串处理。
 * @param {unknown} id
 * @returns {string}
 */
export function toolUseIdFor(id) {
  const raw = typeof id === 'string' ? id : ''
  return TOOL_USE_ID_PATTERN.test(raw) ? raw : hashToolUseId(raw)
}

/**
 * 反代侧的工具名映射；改过名的记进 `renames`（wire 名 -> 客户端名），
 * 响应方向据此还原。
 * @param {unknown} name
 * @param {Map<string, string>} renames
 * @returns {string}
 */
export function toolNameFor(name, renames) {
  const raw = typeof name === 'string' ? name : ''
  if (TOOL_NAME_PATTERN.test(raw)) return raw
  const wire = hashToolName(raw)
  renames.set(wire, raw)
  return wire
}

/**
 * 工具结果的文本形态，用于它对应的调用已经不在 wire 上的情况。
 * @param {{toolUseId: string, content: Array<{text?: string}>}} result
 * @returns {string}
 */
export function toolResultAsText(result) {
  const output = result.content[0]?.text ?? ''
  return '[Output for tool call ' + result.toolUseId + ']:\n' + output
}

/**
 * 把一组工具结果以文本形式接到正文后面（段落之间空一行）。
 * @param {string} text
 * @param {Array<{toolUseId: string, content: Array<{text?: string}>}>} results
 * @returns {string}
 */
export function appendToolResults(text, results) {
  return [text, ...results.map(toolResultAsText)].join('\n\n')
}

/**
 * 工具调用的文本形态，用于折叠转述。
 * @param {{toolUseId: string, name: string, input: unknown}} use
 * @returns {string}
 */
export function describeToolUse(use) {
  return '[Tool call ' + use.toolUseId + ': ' + use.name + ' ' + JSON.stringify(use.input) + ']'
}

/**
 * 「仅限 user 轮带图」的统一报错。
 * @param {string} role
 * @returns {Error}
 */
export function imageOnWrongTurn(role) {
  return kiroError('Kiro accepts images only on user turns; this request has one on a ' + role + ' turn.', 'UNSUPPORTED_CONTENT')
}

/**
 * 空轮次。
 * @param {'user'|'assistant'} role
 * @param {string} [text]
 * @returns {{role: string, text: string, toolUses: object[], toolResults: object[], images: object[]}}
 */
export function emptyTurn(role, text = '') {
  return { role, text, toolUses: [], toolResults: [], images: [] }
}

/**
 * 追加一轮；与上一轮同角色时就地合并（Kiro 只接受严格交替）。
 * @param {object[]} turns
 * @param {{role: string, text: string, toolUses: object[], toolResults: object[], images: object[]}} turn
 */
export function pushTurn(turns, turn) {
  const previous = turns[turns.length - 1]
  if (previous === undefined || previous.role !== turn.role) {
    turns.push(turn)
    return
  }
  previous.text = [previous.text, turn.text].filter(nonEmptyString).join('\n\n')
  previous.toolUses.push(...turn.toolUses)
  previous.toolResults.push(...turn.toolResults)
  previous.images.push(...turn.images)
}

/**
 * 把多段 system 文本合成一段。
 * @param {unknown[]} parts
 * @returns {string}
 */
export function joinSystem(parts) {
  return parts.filter(nonEmptyString).join('\n\n')
}

/**
 * 组装 `additionalModelRequestFields`。
 *
 * 这是 `generateAssistantResponse` 唯一接受生成参数的地方，并且按模型声明的
 * schema 校验（`additionalProperties: false`）：没有 effort、或 max tokens 没有
 * 已知上下界时一律不发，否则整请求 400。
 * @param {object} ctx - 路由上下文（effort / maxTokensBounds / maxTokensField）。
 * @param {number|undefined} maxTokens - 客户端请求的输出上限。
 * @returns {Record<string, unknown>|undefined}
 */
export function generationFields(ctx, maxTokens) {
  const fields = {}
  const { effort, maxTokensBounds: bounds } = ctx
  if (isRecord(effort) && typeof effort.level === 'string') {
    // 不同模型把 effort 放在不同字段下，由模型发现给出。
    const slot = effort.schemaPath === 'reasoning' ? 'reasoning' : 'output_config'
    fields[slot] = { effort: effort.level }
  }
  if (maxTokens !== undefined && maxTokens > 0 && bounds !== undefined) {
    const key = typeof ctx.maxTokensField === 'string' ? ctx.maxTokensField : 'max_tokens'
    // 夹进声明区间：越过上下界同样是 400。
    fields[key] = Math.min(bounds.maximum, Math.max(bounds.minimum, maxTokens))
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

/**
 * 校验请求外形并定下 modelId / conversationId。
 * @param {unknown} body - 客户端请求体。
 * @param {object} ctx - 路由上下文。
 * @param {string} dialect - 错误信息里的协议名（`OpenAI` / `Anthropic`）。
 * @returns {{request: any, messages: any[], modelId: string, conversationId: string}}
 * @throws `INVALID_REQUEST`
 */
export function openRequest(body, ctx, dialect) {
  const request = isRecord(body) ? body : {}
  const { messages } = request
  if (!Array.isArray(messages) || messages.length === 0) {
    throw kiroError(dialect + ' request requires a non-empty messages array', 'INVALID_REQUEST')
  }
  let modelId
  if (nonEmptyString(ctx.modelId)) modelId = ctx.modelId
  else if (nonEmptyString(request.model)) modelId = request.model
  else throw kiroError(dialect + ' request names no model and the route supplies no modelId', 'INVALID_REQUEST')
  const conversationId = nonEmptyString(ctx.conversationId) ? ctx.conversationId : randomUUID()
  return { request, messages, modelId, conversationId }
}

/**
 * wire user 消息。成员顺序固定（content, modelId, origin, context, images），
 * 保证同样的输入产出字节相同的报文。
 * @param {string} modelId
 * @param {{text: string, toolResults: object[], images: object[]}} turn
 * @param {object} [context] - `userInputMessageContext`。
 * @returns {object}
 */
export function userInput(modelId, turn, context) {
  let content = turn.text
  if (content.length === 0) {
    content = turn.toolResults.length > 0 ? PADDING.toolResultsOnly : PADDING.continue
  }
  const message = { content, modelId, origin: ORIGIN }
  if (context !== undefined) message.userInputMessageContext = context
  if (turn.images.length > 0) message.images = turn.images
  return message
}

/** @returns {object} 一条 assistant 补位条目。 */
export function acknowledgement() {
  return { assistantResponseMessage: { content: PADDING.acknowledge } }
}

/**
 * 把轮次排成严格交替、以 assistant 收尾的 history。
 * @param {object[]} turns - 不含当前轮。
 * @param {string} modelId
 * @returns {object[]}
 */
export function alternate(turns, modelId) {
  const history = []
  const expectedRole = () => (history.length % 2 === 0 ? 'user' : 'assistant')
  for (const turn of turns) {
    // 连庄说明另一侧在上游被丢掉了（压缩、无文本的 assistant 步），只能补位。
    if (turn.role !== expectedRole()) {
      history.push(expectedRole() === 'user'
        ? { userInputMessage: userInput(modelId, emptyTurn('user', PADDING.continue)) }
        : acknowledgement())
    }
    if (turn.role === 'user') {
      const context = turn.toolResults.length > 0 ? { toolResults: turn.toolResults } : undefined
      history.push({ userInputMessage: userInput(modelId, turn, context) })
    } else {
      const reply = { content: nonEmptyString(turn.text) ? turn.text : PADDING.acknowledge }
      if (turn.toolUses.length > 0) reply.toolUses = turn.toolUses
      history.push({ assistantResponseMessage: reply })
    }
  }
  // 下一条 user 由 currentMessage 提供。
  if (history.length % 2 === 1) history.push(acknowledgement())
  return history
}

/**
 * 超过条目上限时，把最旧的一整块折成「一条文本转述 + 一条补位」。
 *
 * 只改结构、不删内容：该丢什么由客户端自己的压缩决定。
 * @param {object[]} history - 原地修改。
 * @param {string} modelId
 */
function foldOldest(history, modelId) {
  const overflow = history.length - MAX_HISTORY_ENTRIES
  if (overflow <= 0) return
  const count = FOLD_BLOCK * Math.ceil((overflow + FOLD_RESERVE) / FOLD_BLOCK)
  const transcript = ['Earlier in this conversation:']
  const images = []
  for (let index = 0; index < count; index += 1) {
    const entry = history[index]
    const user = entry.userInputMessage
    if (user !== undefined) {
      transcript.push(`User: ${user.content}`)
      for (const result of user.userInputMessageContext?.toolResults ?? []) {
        transcript.push(toolResultAsText(result))
      }
      // 折叠轮本身是 user 轮，图片有合法座位，跟着搬过去。
      if (user.images !== undefined) images.push(...user.images)
      continue
    }
    const reply = entry.assistantResponseMessage
    transcript.push(`Assistant: ${reply.content}`)
    for (const use of reply.toolUses ?? []) transcript.push(describeToolUse(use))
  }
  const folded = { ...emptyTurn('user', transcript.join('\n\n')), images }
  history.splice(0, count, { userInputMessage: userInput(modelId, folded) }, acknowledgement())
  // 折叠后的第一条真实 user 轮可能在回答刚被折走的调用，这些结果也得降级。
  const next = history[2]?.userInputMessage
  const stranded = next?.userInputMessageContext?.toolResults ?? []
  if (stranded.length > 0) {
    next.content = [next.content, ...stranded.map(toolResultAsText)].join('\n\n')
    delete next.userInputMessageContext
  }
}

/**
 * history 里 assistant 发出过的所有 toolUseId。
 * @param {object[]} history
 * @returns {Set<string>}
 */
export function issuedToolUseIds(history) {
  const ids = new Set()
  for (const entry of history) {
    const uses = entry.assistantResponseMessage?.toolUses
    if (uses === undefined) continue
    for (const use of uses) ids.add(use.toolUseId)
  }
  return ids
}

/**
 * 由轮次生成最终的 wire 请求，并给出外壳要返回的元数据。
 * @param {{request: any, modelId: string, conversationId: string}} opened - `openRequest` 的结果。
 * @param {{turns: object[], tools: object[], system: string,
 *   fields: Record<string, unknown>|undefined, profileArn: unknown,
 *   toolNameMap: Map<string, string>}} parts
 * @returns {{body: object, stream: boolean, model: string, toolNameMap: Map<string, string>}}
 */
export function finishRequest(opened, parts) {
  const { request, modelId, conversationId } = opened
  const { turns, tools, system, fields, profileArn, toolNameMap } = parts

  // 只有 system、或以 assistant 收尾（续写 / 预填充）时，补一条可回答的 user 轮。
  if (turns.length === 0 || turns[turns.length - 1].role === 'assistant') {
    turns.push(emptyTurn('user', PADDING.continue))
  }
  const current = turns.pop()
  const history = alternate(turns, modelId)
  foldOldest(history, modelId)

  const issued = issuedToolUseIds(history)
  const answered = []
  const unanswered = []
  for (const result of current.toolResults) {
    (issued.has(result.toolUseId) ? answered : unanswered).push(result)
  }
  const text = appendToolResults(current.text, unanswered)

  let context
  if (tools.length > 0 || answered.length > 0) {
    context = {}
    if (tools.length > 0) context.tools = tools
    if (answered.length > 0) context.toolResults = answered
  }
  const currentMessage = userInput(modelId, { text, toolResults: answered, images: current.images }, context)

  if (system.length > 0) {
    // 挂在最早的 user 内容前：既是模型看到的顺序，也留在可缓存前缀里。
    const target = history.find(entry => entry.userInputMessage !== undefined)?.userInputMessage ?? currentMessage
    target.content = system + '\n\n' + target.content
  }

  const wire = {}
  if (nonEmptyString(profileArn)) wire.profileArn = profileArn
  if (fields !== undefined) wire.additionalModelRequestFields = fields
  const state = { chatTriggerType: 'MANUAL', conversationId, currentMessage: { userInputMessage: currentMessage } }
  if (history.length > 0) state.history = history
  wire.conversationState = state

  return {
    body: wire,
    stream: request.stream === true,
    model: nonEmptyString(request.model) ? request.model : modelId,
    toolNameMap,
  }
}
