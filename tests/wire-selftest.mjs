/**
 * wire 自测：decodeFrames 的切分鲁棒性 + serializeRequest 的结构规则。
 * 只用 node 内置模块，直接 import 两个目标模块。
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decodeFrames } from '../lib/kiro-eventstream.js'
import { serializeRequest, wireToolUseId } from '../lib/kiro-serialize.js'
import { errorCode } from '../lib/kiro-error.js'

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) process.exitCode = 1
}

/* ---------- eventstream 编码器（仅测试用） ---------- */

const encoder = new TextEncoder()

function header(name, value) {
  const nameBytes = encoder.encode(name)
  const valueBytes = encoder.encode(value)
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  const view = new DataView(out.buffer)
  let offset = 0
  view.setUint8(offset, nameBytes.length); offset += 1
  out.set(nameBytes, offset); offset += nameBytes.length
  view.setUint8(offset, 7); offset += 1
  view.setUint16(offset, valueBytes.length); offset += 2
  out.set(valueBytes, offset)
  return out
}

function frame(headers, payloadObject) {
  const headerBytes = headers.map(([name, value]) => header(name, value))
  const headerLength = headerBytes.reduce((sum, part) => sum + part.length, 0)
  const payload = encoder.encode(JSON.stringify(payloadObject))
  const totalLength = 12 + headerLength + payload.length + 4
  const out = new Uint8Array(totalLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, totalLength)
  view.setUint32(4, headerLength)
  view.setUint32(8, 0) // prelude CRC：不校验
  let offset = 12
  for (const part of headerBytes) { out.set(part, offset); offset += part.length }
  out.set(payload, offset); offset += payload.length
  view.setUint32(offset, 0) // message CRC：不校验
  return out
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

/** 把字节按给定尺寸循环切片，模拟任意读边界。 */
function* chop(bytes, sizes) {
  let offset = 0
  let index = 0
  while (offset < bytes.length) {
    const size = Math.max(1, sizes[index % sizes.length])
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length))
    offset += size
    index += 1
  }
}

async function* asAsync(iterable) {
  for (const chunk of iterable) yield chunk
}

/* ---------- 1. decodeFrames ---------- */

const frames = [
  frame([
    [':event-type', 'assistantResponseEvent'],
    [':content-type', 'application/json'],
    [':message-type', 'event'],
  ], { content: '你好，Kiro', modelId: 'claude-sonnet-4.5' }),
  frame([
    [':event-type', 'reasoningContentEvent'],
    [':content-type', 'application/json'],
    [':message-type', 'event'],
  ], { text: '先看看文件结构…', signature: 'sig-abc' }),
  frame([
    [':event-type', 'toolUseEvent'],
    [':content-type', 'application/json'],
    [':message-type', 'event'],
  ], { toolUseId: 'tooluse_abc123', name: 'read_file', input: '{"path":"a.txt"}', stop: false }),
  frame([
    [':event-type', 'metadataEvent'],
    [':content-type', 'application/json'],
    [':message-type', 'event'],
  ], { tokenUsage: { uncachedInputTokens: 11, outputTokens: 7, totalTokens: 18 }, stopReason: 'END_TURN' }),
]

const streamBytes = concat(frames)
check('frame bytes length', streamBytes.length > 0, `${streamBytes.length} bytes`)

const splitPatterns = [
  [streamBytes.length], // 一整块
  [1], // 逐字节
  [3, 7, 1, 19], // 不规则
  [12], // 正好对齐 prelude
  [11, 13, 5], // 跨 prelude 边界
]

for (const pattern of splitPatterns) {
  const seen = []
  let activity = 0
  for await (const decoded of decodeFrames(asAsync(chop(streamBytes, pattern)), () => { activity += 1 })) {
    seen.push({
      type: decoded.headers[':event-type'],
      payload: JSON.parse(new TextDecoder().decode(decoded.payload)),
    })
  }
  const label = `split ${pattern.join('/')}`
  check(`${label}: 帧数 = 4`, seen.length === 4, `got ${seen.length}`)
  check(`${label}: 事件顺序`, seen.map((s) => s.type).join(',')
    === 'assistantResponseEvent,reasoningContentEvent,toolUseEvent,metadataEvent',
    seen.map((s) => s.type).join(','))
  check(`${label}: text payload`, seen[0].payload.content === '你好，Kiro', JSON.stringify(seen[0].payload))
  check(`${label}: reasoning payload`, seen[1].payload.text === '先看看文件结构…' && seen[1].payload.signature === 'sig-abc')
  check(`${label}: toolUse payload`, seen[2].payload.toolUseId === 'tooluse_abc123'
    && seen[2].payload.name === 'read_file' && seen[2].payload.input === '{"path":"a.txt"}')
  check(`${label}: metadata payload`, seen[3].payload.stopReason === 'END_TURN'
    && seen[3].payload.tokenUsage.totalTokens === 18)
  // 期望的读取次数 = 按 pattern 循环切片后的 chunk 数
  let expectedChunks = 0
  for (let offset = 0; offset < streamBytes.length;) {
    offset += Math.max(1, pattern[expectedChunks % pattern.length])
    expectedChunks += 1
  }
  check(`${label}: onActivity 被调用`, activity === expectedChunks, `activity=${activity} expect=${expectedChunks}`)
}

// 头部字段长度/类型错误 -> MALFORMED_RESPONSE
{
  const bad = frame([[':event-type', 'assistantResponseEvent']], { content: 'x' })
  const view = new DataView(bad.buffer)
  view.setUint32(0, 40 * 1024 * 1024) // 超过 16 MiB 上限
  let code = ''
  try {
    for await (const _ of decodeFrames(asAsync([bad]))) { void _ }
  } catch (error) { code = errorCode(error) }
  check('超大 totalLength -> MALFORMED_RESPONSE', code === 'MALFORMED_RESPONSE', code)
}
{
  // totalLength 小于 prelude + header + crc 的自洽下界
  const bad = frame([[':event-type', 'assistantResponseEvent']], { content: 'x' })
  new DataView(bad.buffer).setUint32(0, 14)
  let code = ''
  try {
    for await (const _ of decodeFrames(asAsync([bad]))) { void _ }
  } catch (error) { code = errorCode(error) }
  check('自洽性失败 -> MALFORMED_RESPONSE', code === 'MALFORMED_RESPONSE', code)
}
{
  // 帧中间结束
  let code = ''
  try {
    for await (const _ of decodeFrames(asAsync([streamBytes.subarray(0, streamBytes.length - 7)]))) { void _ }
  } catch (error) { code = errorCode(error) }
  check('截断 -> STREAM_CLOSED', code === 'STREAM_CLOSED', code)
}
{
  // header 值类型不是 7
  const bad = frame([[':event-type', 'assistantResponseEvent']], { content: 'x' })
  const nameLen = bad[12]
  bad[12 + 1 + nameLen] = 0 // type
  let code = ''
  try {
    for await (const _ of decodeFrames(asAsync([bad]))) { void _ }
  } catch (error) { code = errorCode(error) }
  check('header type != 7 -> MALFORMED_RESPONSE', code === 'MALFORMED_RESPONSE', code)
}

{
  // header 值长度声明超出 header 区
  const bad = frame([[':event-type', 'assistantResponseEvent']], { content: 'x' })
  const view = new DataView(bad.buffer)
  const nameLen = bad[12]
  const valueLenOffset = 12 + 1 + nameLen + 1
  view.setUint16(valueLenOffset, 4096)
  let code = ''
  try {
    for await (const _ of decodeFrames(asAsync([bad]))) { void _ }
  } catch (error) { code = errorCode(error) }
  check('header 值越界 -> MALFORMED_RESPONSE', code === 'MALFORMED_RESPONSE', code)
}
{
  // Buffer 作为 chunk（Node 的 read 结果）也要能吃下
  const bufChunks = [Buffer.from(streamBytes.subarray(0, 100)), Buffer.from(streamBytes.subarray(100))]
  const seen = []
  for await (const decoded of decodeFrames(asAsync(bufChunks))) {
    seen.push(decoded.headers[':event-type'])
  }
  check('Buffer chunk 可用', seen.length === 4, seen.join(','))
}
{
  // 空流：不产出任何帧，也不抛错
  const seen = []
  for await (const decoded of decodeFrames(asAsync([]))) seen.push(decoded)
  check('空流产出 0 帧', seen.length === 0, String(seen.length))
}
{
  // 非字节 chunk 明确报错而不是静默跳过
  let code = ''
  try {
    for await (const _ of decodeFrames(asAsync(['not bytes']))) { void _ }
  } catch (error) { code = errorCode(error) }
  check('非字节 chunk -> MALFORMED_RESPONSE', code === 'MALFORMED_RESPONSE', code)
}
{
  // 跨帧拼包时 payload 视图仍然有效（subarray 视图 + 后续整体替换 buffered）
  const firstFramePayloads = []
  for await (const decoded of decodeFrames(asAsync([streamBytes]))) {
    firstFramePayloads.push(new TextDecoder().decode(decoded.payload))
  }
  check('多帧一次到达时每个 payload 独立正确', firstFramePayloads.length === 4
    && firstFramePayloads[0].includes('你好，Kiro')
    && firstFramePayloads[3].includes('END_TURN'))
}

/* ---------- 2. wireToolUseId ---------- */

check('合法 id 原样返回', wireToolUseId('call_abc-123') === 'call_abc-123')
check('非法 id 加前缀', wireToolUseId('fc/xyz:1').startsWith('tooluse_'), wireToolUseId('fc/xyz:1'))
check('非法 id 确定性', wireToolUseId('fc/xyz:1') === wireToolUseId('fc/xyz:1'))
check('非法 id 长度 32', wireToolUseId('fc/xyz:1').slice('tooluse_'.length).length === 32)
check('非法 id 满足 wire 正则', /^[A-Za-z0-9_-]{1,64}$/.test(wireToolUseId('fc/xyz:1')))

/* ---------- 3. serializeRequest：交替 / toolResults / 改名 / system ---------- */

const imageBytes = Buffer.from('fake-png-bytes').toString('base64')

const mixed = {
  provider: 'kiro-proxy',
  model: 'claude-sonnet-4.5',
  system: '你是 Kiro 助手。',
  reasoningEffort: 'high',
  maxTokens: 100000,
  messages: [
    { role: 'system', content: [{ type: 'text', text: '忽略：这是历史里的 system 块' }] },
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '内部推理应被丢弃' },
        { type: 'text', text: '我先读文件。' },
        { type: 'tool-call', id: 'call_1', name: 'mcp__fs/read', arguments: '{"path":"a.txt"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容 A' }] },
    { role: 'tool', toolCallId: 'call_ghost', content: [{ type: 'text', text: '孤儿工具输出' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图并总结' },
        { type: 'image', attachment: { attachmentId: 'att-1' } },
      ],
    },
  ],
  tools: [
    { name: 'mcp__fs/read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'shell', description: '执行命令', parameters: { type: 'object', properties: {} } },
  ],
}

const ctxMixed = {
  conversationId: '11111111-2222-4333-8444-555555555555',
  modelId: 'claude-sonnet-4.5',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/X',
  effort: { schemaPath: 'output_config', level: 'high' },
  maxTokensBounds: { minimum: 1024, maximum: 32000 },
  images: new Map([['att-1', { format: 'png', source: { bytes: imageBytes } }]]),
}

const { body, toolNameMap } = serializeRequest(mixed, ctxMixed)
const state = body.conversationState
const history = state.history ?? []

check('profileArn 透传', body.profileArn === ctxMixed.profileArn)
check('additionalModelRequestFields.output_config', body.additionalModelRequestFields?.output_config?.effort === 'high',
  JSON.stringify(body.additionalModelRequestFields))
check('max_tokens 夹到上界', body.additionalModelRequestFields?.max_tokens === 32000,
  String(body.additionalModelRequestFields?.max_tokens))
check('无 inferenceConfig/temperature/topP/stop', body.inferenceConfig === undefined
  && body.temperature === undefined && body.topP === undefined && body.stop === undefined)
check('chatTriggerType = MANUAL', state.chatTriggerType === 'MANUAL')
check('conversationId 透传', state.conversationId === ctxMixed.conversationId)

// 交替
let alternates = true
for (let index = 0; index < history.length; index += 1) {
  const entry = history[index]
  const isUser = 'userInputMessage' in entry
  if (index % 2 === 0 ? !isUser : isUser) alternates = false
}
check('history 严格交替且以 user 开头', alternates, history.map((e) => ('userInputMessage' in e ? 'u' : 'a')).join(''))
check('history 以 assistant 结尾', history.length > 0 && 'assistantResponseMessage' in history.at(-1),
  history.map((e) => ('userInputMessage' in e ? 'u' : 'a')).join(''))

// system 前置到最早 user
const firstUser = history.find((entry) => 'userInputMessage' in entry)
check('system 前置到最早 user', firstUser.userInputMessage.content.startsWith('你是 Kiro 助手。'),
  firstUser.userInputMessage.content.slice(0, 40))
check('system 只出现一次', JSON.stringify(history).split('你是 Kiro 助手。').length === 2)

// 每条 user 轮都带 modelId / origin
check('每条 user 轮带 modelId+origin', history
  .filter((entry) => 'userInputMessage' in entry)
  .every((entry) => entry.userInputMessage.modelId === 'claude-sonnet-4.5'
    && entry.userInputMessage.origin === 'AI_EDITOR')
  && state.currentMessage.userInputMessage.modelId === 'claude-sonnet-4.5')

// assistant 轮丢 reasoning 块
const assistantEntry = history.find((entry) => 'assistantResponseMessage' in entry)
check('assistant 丢弃 reasoning 块', !assistantEntry.assistantResponseMessage.content.includes('内部推理'),
  assistantEntry.assistantResponseMessage.content)
check('assistant toolUses 存在', Array.isArray(assistantEntry.assistantResponseMessage.toolUses)
  && assistantEntry.assistantResponseMessage.toolUses.length === 1)

// 工具改名 + map
const wireName = assistantEntry.assistantResponseMessage.toolUses[0].name
check('非法工具名被改名', /^tool_[0-9a-f]{12}$/.test(wireName), wireName)
check('改名记入 map（wire -> harness）', toolNameMap.get(wireName) === 'mcp__fs/read', JSON.stringify([...toolNameMap]))
check('合法工具名原样保留', body.conversationState.currentMessage.userInputMessage
  .userInputMessageContext.tools.some((tool) => tool.toolSpecification.name === 'shell'))
check('工具定义转 toolSpecification', body.conversationState.currentMessage.userInputMessage
  .userInputMessageContext.tools.every((tool) => tool.toolSpecification?.inputSchema?.json !== undefined))

// toolResults 挂载 + 孤儿降级
const current = state.currentMessage.userInputMessage
const currentResults = current.userInputMessageContext?.toolResults ?? []
check('匹配的 toolResult 挂到 currentMessage', currentResults.length === 1
  && currentResults[0].toolUseId === wireToolUseId('call_1')
  && currentResults[0].status === 'success', JSON.stringify(currentResults))
check('孤儿 toolResult 降级为文本', current.content.includes('[Output for tool call')
  && current.content.includes('孤儿工具输出'), current.content)
check('user 轮文本保留', current.content.includes('看图并总结'))

// 图片只上 user 轮
check('图片落在 currentMessage', Array.isArray(current.images) && current.images.length === 1
  && current.images[0].format === 'png' && current.images[0].source.bytes === imageBytes,
  JSON.stringify(current.images))
check('history 里的 user 轮没有多余图片', history.every((entry) => !('userInputMessage' in entry)
  || entry.userInputMessage.images === undefined))

/* ---------- 4. 缺图 / assistant 图片 / 空消息 ---------- */

{
  let code = ''
  try {
    serializeRequest({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] }] },
      { conversationId: 'c', modelId: 'm' })
  } catch (error) { code = errorCode(error) }
  check('缺图 -> UNSUPPORTED_CONTENT', code === 'UNSUPPORTED_CONTENT', code)
}
{
  let code = ''
  try {
    serializeRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
    }, { conversationId: 'c', modelId: 'm', images: new Map([['att-1', { format: 'png', source: { bytes: imageBytes } }]]) })
  } catch (error) { code = errorCode(error) }
  check('assistant 图片 -> UNSUPPORTED_CONTENT', code === 'UNSUPPORTED_CONTENT', code)
}
{
  let code = ''
  try { serializeRequest({ messages: [] }, { conversationId: 'c', modelId: 'm' }) } catch (error) { code = errorCode(error) }
  check('空消息 -> INVALID_REQUEST', code === 'INVALID_REQUEST', code)
}

/* ---------- 5. 缺失一侧补齐 / 末轮 assistant ---------- */

{
  const { body: shortBody } = serializeRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
    ],
  }, { conversationId: 'c', modelId: 'm' })
  const shortHistory = shortBody.conversationState.history
  check('末轮 assistant 时补 Continue 作为 currentMessage',
    shortBody.conversationState.currentMessage.userInputMessage.content === 'Continue',
    shortBody.conversationState.currentMessage.userInputMessage.content)
  check('连续 user 合并成一轮', shortHistory.length === 2
    && shortHistory[0].userInputMessage.content === 'a\n\nb',
    JSON.stringify(shortHistory.map((e) => ('userInputMessage' in e ? `u:${e.userInputMessage.content}` : 'a'))))
}

/* ---------- 6. history 198 上限折叠 ---------- */

{
  const messages = []
  for (let index = 0; index < 130; index += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `问 ${index}` }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `答 ${index}` }] })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: '最后一问' }] })
  const { body: longBody } = serializeRequest({ system: 'SYS', messages }, { conversationId: 'c', modelId: 'm' })
  const longHistory = longBody.conversationState.history
  check('折叠前会超 198（构造验证）', 260 > 198)
  check('折叠后 history <= 198', longHistory.length <= 198, `len=${longHistory.length}`)
  // 260 条 -> 折 150 条整块 -> 112 条（整块折叠，不是逐条折到 198）
  check('按整块折叠（260 -> 112）', longHistory.length === 112, `len=${longHistory.length}`)
  check('折叠后仍严格交替', longHistory.every((entry, index) => (index % 2 === 0
    ? 'userInputMessage' in entry : 'assistantResponseMessage' in entry)),
    longHistory.map((e) => ('userInputMessage' in e ? 'u' : 'a')).join('').slice(0, 12))
  check('折叠轮带前缀（system 之后）', longHistory[0].userInputMessage.content.includes('[earlier conversation]\n'),
    longHistory[0].userInputMessage.content.slice(0, 40))
  check('折叠轮含最早内容', longHistory[0].userInputMessage.content.includes('问 0'))
  check('折叠轮下一轮是 assistant 占位', longHistory[1].assistantResponseMessage.content === 'understood')
  check('system 落在折叠后的最早 user 上', longHistory[0].userInputMessage.content.startsWith('SYS\n\n[earlier conversation]'),
    longHistory[0].userInputMessage.content.slice(0, 40))
  check('最新内容仍在 history 尾部', longHistory.at(-2).userInputMessage.content.includes('问 129'))
  check('currentMessage 是最后一问', longBody.conversationState.currentMessage.userInputMessage.content === '最后一问')

  // 无 system 时折叠轮必须以前缀开头
  const { body: noSysBody } = serializeRequest({ messages }, { conversationId: 'c', modelId: 'm' })
  check('无 system 时折叠轮以 [earlier conversation] 开头',
    noSysBody.conversationState.history[0].userInputMessage.content.startsWith('[earlier conversation]\n'),
    noSysBody.conversationState.history[0].userInputMessage.content.slice(0, 30))

  // 刚过上限（199 条 history）也只折一块，避免每轮都 miss 前缀缓存
  const justOver = []
  for (let index = 0; index < 100; index += 1) {
    justOver.push({ role: 'user', content: [{ type: 'text', text: `q${index}` }] })
    justOver.push({ role: 'assistant', content: [{ type: 'text', text: `a${index}` }] })
  }
  justOver.push({ role: 'user', content: [{ type: 'text', text: 'tail' }] })
  const { body: justBody } = serializeRequest({ messages: justOver }, { conversationId: 'c', modelId: 'm' })
  const justHistory = justBody.conversationState.history
  check('刚过上限只折一块（200 -> 52）', justHistory.length === 52, `len=${justHistory.length}`)
  check('刚过上限折叠后仍交替', justHistory.every((entry, index) => (index % 2 === 0
    ? 'userInputMessage' in entry : 'assistantResponseMessage' in entry)))
}

/* ---------- 7. 折叠后孤儿结果降级（引用被折掉的 call） ---------- */

{
  const messages = []
  for (let index = 0; index < 130; index += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `问 ${index}` }] })
    if (index === 0) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_old', name: 'shell', arguments: '{}' }],
      })
      continue
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `答 ${index}` }] })
  }
  // 这条 tool 结果引用的是 index 0 的调用，而那一轮会被折叠掉
  messages.splice(2, 0, { role: 'tool', toolCallId: 'call_old', content: [{ type: 'text', text: '旧调用输出' }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: '收尾' }] })
  const { body: foldBody } = serializeRequest({ messages }, { conversationId: 'c', modelId: 'm' })
  const foldHistory = foldBody.conversationState.history
  const issuedAfterFold = new Set(foldHistory.flatMap((entry) => 'assistantResponseMessage' in entry
    ? (entry.assistantResponseMessage.toolUses ?? []).map((use) => use.toolUseId) : []))
  const danglingResult = foldHistory.some((entry) => 'userInputMessage' in entry
    && (entry.userInputMessage.userInputMessageContext?.toolResults ?? [])
      .some((result) => !issuedAfterFold.has(result.toolUseId)))
  const asText = foldHistory.some((entry) => 'userInputMessage' in entry
    && entry.userInputMessage.content.includes('旧调用输出'))
  check('折叠后不存在悬空 toolResults', !danglingResult)
  check('折叠后被折掉调用的结果降级为文本', asText,
    foldHistory.slice(0, 3).map((entry) => ('userInputMessage' in entry
      ? entry.userInputMessage.content.slice(0, 60) : 'a')).join(' | '))
}

/* ---------- 8. toolNameMap 预置 / 自定义改名器 ---------- */

{
  const { body: customBody, toolNameMap: customMap } = serializeRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'web.search', description: 'd', parameters: { type: 'object' } }],
  }, {
    conversationId: 'c',
    modelId: 'm',
    toolNameMap: (name) => `t_${name.replace(/[^A-Za-z0-9_]/g, '_')}`,
  })
  const customName = customBody.conversationState.currentMessage.userInputMessage
    .userInputMessageContext.tools[0].toolSpecification.name
  check('自定义改名器生效', customName === 't_web_search', customName)
  check('自定义改名记入 map', customMap.get('t_web_search') === 'web.search', JSON.stringify([...customMap]))
}

/* ---------- 9. 单轮 / 占位文本 / history 缺省 ---------- */

{
  const { body: single } = serializeRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'only' }] }],
  }, { conversationId: 'cid', modelId: 'm' })
  check('单轮请求没有 history 键', single.conversationState.history === undefined,
    JSON.stringify(Object.keys(single.conversationState)))
  check('单轮 currentMessage 内容正确',
    single.conversationState.currentMessage.userInputMessage.content === 'only')
  check('无 system 时内容不带前缀', single.conversationState.currentMessage.userInputMessage.content === 'only')

  // 只有 tool 结果的 user 轮 -> 'Tool results provided.'
  const { body: toolOnly } = serializeRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'shell', arguments: '' }] },
      { role: 'tool', toolCallId: 'c1', content: [] },
    ],
  }, { conversationId: 'cid', modelId: 'm' })
  const toolOnlyMsg = toolOnly.conversationState.currentMessage.userInputMessage
  check('tool-only user 轮用占位文本', toolOnlyMsg.content === 'Tool results provided.', toolOnlyMsg.content)
  check('空工具输出写 (no output)', toolOnlyMsg.userInputMessageContext.toolResults[0].content[0].text === '(no output)',
    JSON.stringify(toolOnlyMsg.userInputMessageContext.toolResults))
  check('空 arguments 解析为 {}', JSON.stringify(toolOnly.conversationState.history
    .find((e) => 'assistantResponseMessage' in e).assistantResponseMessage.toolUses[0].input) === '{}')

  // 无文本的 assistant 步 -> 'understood'
  const { body: silentAssistant } = serializeRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '只思考不说话' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ],
  }, { conversationId: 'cid', modelId: 'm' })
  check('无文本 assistant 轮用 understood', silentAssistant.conversationState.history
    .find((e) => 'assistantResponseMessage' in e).assistantResponseMessage.content === 'understood')
  check('assistant 轮没有 toolUses 键时省略', silentAssistant.conversationState.history
    .find((e) => 'assistantResponseMessage' in e).assistantResponseMessage.toolUses === undefined)

  // effort 不存在时不发 additionalModelRequestFields
  const { body: noFields } = serializeRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    maxTokens: 4096,
  }, { conversationId: 'cid', modelId: 'm' })
  check('无 effort/bounds 时不发 additionalModelRequestFields', noFields.additionalModelRequestFields === undefined)

  // reasoning schemaPath
  const { body: reasoningFields } = serializeRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    maxTokens: 100,
  }, {
    conversationId: 'cid', modelId: 'm',
    effort: { schemaPath: 'reasoning', level: 'low' },
    maxTokensBounds: { minimum: 1024, maximum: 32000 },
  })
  check('reasoning schemaPath 生效', reasoningFields.additionalModelRequestFields.reasoning.effort === 'low')
  check('max_tokens 夹到下界', reasoningFields.additionalModelRequestFields.max_tokens === 1024,
    String(reasoningFields.additionalModelRequestFields.max_tokens))

  // tool-call id 非法时改名，且 result 仍能配对
  const { body: idBody } = serializeRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'fc/1:abc', name: 'shell', arguments: '{"a":1}' }] },
      { role: 'tool', toolCallId: 'fc/1:abc', content: [{ type: 'text', text: 'ok' }] },
    ],
  }, { conversationId: 'cid', modelId: 'm' })
  const idHistory = idBody.conversationState.history
  const issuedId = idHistory.find((e) => 'assistantResponseMessage' in e)
    .assistantResponseMessage.toolUses[0].toolUseId
  const carriedId = idBody.conversationState.currentMessage.userInputMessage
    .userInputMessageContext.toolResults[0].toolUseId
  check('非法 tool-call id 改名后 call/result 仍配对', issuedId === carriedId
    && issuedId.startsWith('tooluse_'), `${issuedId} vs ${carriedId}`)
}

/* ---------- 10. history 轮里的 toolResults 也保留（未折叠时） ---------- */

{
  const { body: historyToolBody } = serializeRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_hist', name: 'shell', arguments: '{"cmd":"ls"}' }] },
      { role: 'tool', toolCallId: 'call_hist', content: [{ type: 'text', text: 'a.txt' }] },
      { role: 'assistant', content: [{ type: 'text', text: '读到了' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
  }, { conversationId: 'c', modelId: 'm' })
  const historyTool = historyToolBody.conversationState.history
  const carried = historyTool.find((entry) => 'userInputMessage' in entry
    && entry.userInputMessage.userInputMessageContext?.toolResults !== undefined)
  check('history user 轮保留 toolResults', carried !== undefined
    && carried.userInputMessage.userInputMessageContext.toolResults[0].toolUseId === wireToolUseId('call_hist'),
    JSON.stringify(carried?.userInputMessage.userInputMessageContext))
  check('history 结构 u/a/u/a', historyTool.map((e) => ('userInputMessage' in e ? 'u' : 'a')).join('') === 'uaua',
    historyTool.map((e) => ('userInputMessage' in e ? 'u' : 'a')).join(''))
  check('body 可 JSON 序列化且无 undefined', JSON.stringify(historyToolBody).includes('call_hist'))
}

/* ---------- 10. 关键结构快照（写进日志便于 Lead 核对） ---------- */

const snapshot = {
  mixed: {
    profileArn: body.profileArn,
    additionalModelRequestFields: body.additionalModelRequestFields,
    historyShape: history.map((entry) => ('userInputMessage' in entry
      ? { user: entry.userInputMessage.content.slice(0, 24) }
      : { assistant: entry.assistantResponseMessage.content.slice(0, 24) })),
    currentMessage: {
      content: state.currentMessage.userInputMessage.content.slice(0, 80),
      toolResults: state.currentMessage.userInputMessage.userInputMessageContext?.toolResults,
      tools: state.currentMessage.userInputMessage.userInputMessageContext?.tools?.map((t) => t.toolSpecification.name),
      images: state.currentMessage.userInputMessage.images?.length,
    },
    toolNameMap: [...toolNameMap],
  },
}
results.push({ name: '结构快照', ok: true, detail: '' })

/* ---------- 输出摘要 ---------- */

const passed = results.filter((entry) => entry.ok).length
const lines = []
lines.push('== wire-selftest ==')
for (const entry of results) {
  lines.push(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? `   [${entry.detail}]` : ''}`)
}
lines.push('')
lines.push('-- 结构快照 --')
lines.push(JSON.stringify(snapshot, null, 2))
lines.push(`--- ${passed}/${results.length} passed, exit=${passed === results.length ? 0 : 1}`)
const text = lines.join('\n')
console.log(text)
// 日志由脚本自己写 UTF-8，避免 PowerShell 重定向产生 UTF-16 文件。
const here = dirname(fileURLToPath(import.meta.url))
writeFileSync(join(here, 'wire-selftest.log'), `${text}\n`, 'utf8')
process.exitCode = passed === results.length ? 0 : 1
