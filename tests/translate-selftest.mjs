/**
 * lib/kiro-openai.js 与 lib/kiro-anthropic.js 的自测。
 *
 * 只用 node: 内置模块，`node .scratch/translate-selftest.mjs` 直接跑。
 * 断言失败即抛，日志同时写文件，方便 Lead 复查。
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  newOpenAiState,
  openAiToWire,
  wireFinish,
  wireToOpenAiChunk,
  wireToOpenAiResponse,
} from '../lib/kiro-openai.js'
import {
  anthropicResponse,
  anthropicStart,
  anthropicStop,
  anthropicToWire,
  newAnthropicState,
  wireToAnthropicEvent,
} from '../lib/kiro-anthropic.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = join(HERE, 'translate-selftest.log')
writeFileSync(LOG, '', 'utf8')

let passed = 0
let failed = 0

/** 写一行日志（同时 stdout 与文件）。 */
function log(line = '') {
  appendFileSync(LOG, `${line}\n`, 'utf8')
  process.stdout.write(`${line}\n`)
}

/** 断言：真值。 */
function ok(condition, label) {
  if (condition) {
    passed += 1
    log(`  ok   ${label}`)
    return
  }
  failed += 1
  log(`  FAIL ${label}`)
}

/** 断言：深相等（用 JSON 序列化比较，够用且报错可读）。 */
function eq(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left === right) {
    passed += 1
    log(`  ok   ${label}`)
    return
  }
  failed += 1
  log(`  FAIL ${label}`)
  log(`       actual   = ${left}`)
  log(`       expected = ${right}`)
}

/** 断言：抛错且 code 匹配。 */
function throwsCode(fn, code, label) {
  try {
    fn()
  } catch (error) {
    if (error?.code === code) {
      passed += 1
      log(`  ok   ${label} (code=${error.code})`)
      return
    }
    failed += 1
    log(`  FAIL ${label} — 抛了 ${error?.code ?? error?.name}: ${error?.message}`)
    return
  }
  failed += 1
  log(`  FAIL ${label} — 没有抛错`)
}

/** 一张 1x1 PNG 的 data URL。 */
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

// ===========================================================================
log('== 1. OpenAI -> wire ==')

const openAiBody = {
  model: 'claude-sonnet-4.5',
  stream: true,
  max_tokens: 4096,
  messages: [
    { role: 'system', content: 'You are a careful engineer.' },
    { role: 'developer', content: [{ type: 'text', text: 'Prefer tables.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: PNG_1X1 } },
      ],
    },
    {
      role: 'assistant',
      content: 'Let me look it up.',
      tool_calls: [
        {
          id: 'call_abc123',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_abc123', content: 'file contents' },
    { role: 'user', content: 'thanks, summarize' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: { name: 'mcp.bad-name', description: 'needs renaming', parameters: { type: 'object' } },
    },
  ],
}

const openAiCtx = {
  modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  conversationId: 'conv-openai-1',
  profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/P',
  systemPrefix: '[route]',
  maxTokensBounds: { minimum: 1024, maximum: 32000 },
  effort: { schemaPath: 'output_config', level: 'medium' },
}
const wire1 = openAiToWire(openAiBody, openAiCtx)
const wire1Body = wire1.body

eq(wire1.stream, true, 'stream 透传')
eq(wire1.model, 'claude-sonnet-4.5', 'model 回显客户端请求名')
eq(wire1Body.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/P', 'profileArn 落位')
eq(wire1Body.conversationState.chatTriggerType, 'MANUAL', 'chatTriggerType 固定 MANUAL')
eq(wire1Body.conversationState.conversationId, 'conv-openai-1', 'conversationId 用 ctx 的')
eq(
  wire1Body.additionalModelRequestFields,
  { output_config: { effort: 'medium' }, max_tokens: 4096 },
  'additionalModelRequestFields 写 effort + 夹取后的 max_tokens',
)

const wire1History = wire1Body.conversationState.history
const wire1Current = wire1Body.conversationState.currentMessage.userInputMessage

// 折叠后：user(图) -> assistant(tool_calls) 进 history；tool 结果与最后一条 user
// 合并成 currentMessage（toolResults 挂在承载它的 user 轮上）。
eq(wire1History.length, 2, 'history 严格交替后 2 条（user/assistant，以 assistant 结尾）')
ok('userInputMessage' in wire1History[0], 'history[0] 是 user')
ok('assistantResponseMessage' in wire1History[1], 'history[1] 是 assistant')

// system + developer 合成 ctx.systemPrefix，拼进最早 user 内容开头。
eq(
  wire1History[0].userInputMessage.content,
  '[route]\n\nYou are a careful engineer.\n\nPrefer tables.\n\nwhat is in this image?',
  'system/developer/ctx.systemPrefix 合成并前置到最早 user 轮',
)
eq(
  wire1History[0].userInputMessage.images,
  [{ format: 'png', source: { bytes: PNG_1X1.split(',')[1] } }],
  'data: URL 图片转 {format, source:{bytes}}',
)
eq(wire1History[0].userInputMessage.origin, 'AI_EDITOR', 'origin 固定 AI_EDITOR')
eq(
  wire1History[0].userInputMessage.modelId,
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  '每轮重复 modelId',
)

// assistant tool_calls -> toolUses
eq(wire1History[1].assistantResponseMessage.content, 'Let me look it up.', 'assistant 文本保留')
eq(
  wire1History[1].assistantResponseMessage.toolUses,
  [{ toolUseId: 'call_abc123', name: 'read_file', input: { path: 'a.txt' } }],
  'assistant tool_calls -> toolUses（arguments 已解析成对象）',
)

// role:'tool' -> toolResults（挂在承载它的 user 轮上，这里就是 currentMessage）
eq(
  wire1Current.userInputMessageContext.toolResults,
  [{ toolUseId: 'call_abc123', content: [{ text: 'file contents' }], status: 'success' }],
  'role:tool 的 tool_call_id 映射成 toolResults，挂在 user 轮',
)

// currentMessage 是最后一条 user
eq(wire1Current.content, 'thanks, summarize', '最后一条 user 成为 currentMessage')
ok(wire1Current.userInputMessageContext.tools.length === 2, 'currentMessage 带 tools')
eq(
  wire1Current.userInputMessageContext.tools[0],
  {
    toolSpecification: {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        json: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  },
  'tools 定义落成 toolSpecification.inputSchema.json',
)
ok(/^tool_[0-9a-f]{12}$/.test(wire1Current.userInputMessageContext.tools[1].toolSpecification.name), '非法工具名被改名')
eq(wire1.toolNameMap.size, 1, 'toolNameMap 记录了一条改名')
eq(
  [...wire1.toolNameMap.values()][0],
  'mcp.bad-name',
  'toolNameMap 保存 线协议名 -> 客户端名',
)

// 边界：图片只允许 user 轮
throwsCode(
  () => openAiToWire({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: PNG_1X1 } }] },
    ],
  }, { modelId: 'm' }),
  'UNSUPPORTED_CONTENT',
  'assistant 轮图片抛 UNSUPPORTED_CONTENT',
)
throwsCode(
  () => openAiToWire({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }],
  }, { modelId: 'm' }),
  'UNSUPPORTED_CONTENT',
  'http(s) 图片抛 UNSUPPORTED_CONTENT',
)
throwsCode(
  () => openAiToWire({ model: 'm', messages: [] }, { modelId: 'm' }),
  'INVALID_REQUEST',
  '空 messages 抛 INVALID_REQUEST',
)

// 只有 system 的请求也要有可回答的 user 轮
const onlySystem = openAiToWire({ model: 'm', messages: [{ role: 'system', content: 'S' }] }, { modelId: 'm' })
eq(
  onlySystem.body.conversationState.currentMessage.userInputMessage.content,
  'S\n\nContinue',
  '只有 system 时补 Continue 轮，system 前置',
)
ok(onlySystem.body.conversationState.history === undefined, '单轮请求不带 history 字段')

// 连续 assistant 合并
const merged = openAiToWire({
  model: 'm',
  messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b1' },
    { role: 'assistant', content: 'b2' },
    { role: 'user', content: 'c' },
  ],
}, { modelId: 'm' })
eq(merged.body.conversationState.history.length, 2, '连续 assistant 合并成一条')
eq(
  merged.body.conversationState.history[1].assistantResponseMessage.content,
  'b1\n\nb2',
  '合并后的 assistant 文本用空行连接',
)

// 以 assistant 结尾时补中性 user 轮
const trailing = openAiToWire({
  model: 'm',
  messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ],
}, { modelId: 'm' })
eq(
  trailing.body.conversationState.currentMessage.userInputMessage.content,
  'Continue',
  '以 assistant 结尾时补 Continue 作为 currentMessage',
)

// 边界：tool 轮的图片被提升到承载它的 user 轮（Kiro 的工具结果没有图片槽位，
// 而 user 轮有 images 字段；serialize.ts 也这么做）。
const toolImage = openAiToWire({
  model: 'm',
  messages: [
    { role: 'user', content: 'take a screenshot' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_shot', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_shot',
      content: [{ type: 'image_url', image_url: { url: PNG_1X1 } }],
    },
  ],
}, { modelId: 'm' })
eq(
  toolImage.body.conversationState.currentMessage.userInputMessage.images,
  [{ format: 'png', source: { bytes: PNG_1X1.split(',')[1] } }],
  'tool 轮图片提升到 user 轮 images（不是丢弃，也不是硬失败）',
)
eq(
  toolImage.body.conversationState.currentMessage.userInputMessage.content,
  'Tool results provided.',
  'tool 结果正文为空时用占位文本',
)

// 边界：history 超过 198 条时折叠最旧的一段，且保持严格交替
const manyMessages = []
for (let i = 0; i < 260; i += 1) {
  manyMessages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` })
}
manyMessages.push({ role: 'user', content: 'final' })
const folded = openAiToWire({ model: 'm', messages: manyMessages }, { modelId: 'm' })
const foldedHistory = folded.body.conversationState.history
ok(foldedHistory.length <= 198, `history 折叠到上限内（${foldedHistory.length} <= 198）`)
ok(
  foldedHistory.every((entry, index) => (index % 2 === 0)
    ? 'userInputMessage' in entry
    : 'assistantResponseMessage' in entry),
  '折叠后仍然严格 user/assistant 交替',
)
ok(
  foldedHistory[0].userInputMessage.content.startsWith('Earlier in this conversation:'),
  '折叠块以 Earlier in this conversation: 开头',
)
eq(
  folded.body.conversationState.currentMessage.userInputMessage.content,
  'final',
  '折叠不影响 currentMessage',
)

// ===========================================================================
log('')
log('== 2. wire 事件 -> OpenAI SSE ==')

const openAiState = newOpenAiState({ id: 'chatcmpl-test', model: 'claude-sonnet-4.5', created: 1700000000 })
const events = [
  { kind: 'reasoning', text: 'thinking… ' },
  { kind: 'reasoning', text: 'more' },
  { kind: 'text', text: 'Hello' },
  { kind: 'text', text: ' world' },
  { kind: 'tool-start', id: 'tooluse_1', name: 'read_file' },
  { kind: 'tool-delta', id: 'tooluse_1', argumentsDelta: '{"path":' },
  { kind: 'tool-delta', id: 'tooluse_1', argumentsDelta: '"a.txt"}' },
  { kind: 'tool-stop', id: 'tooluse_1' },
  { kind: 'usage', inputTokens: 120, outputTokens: 30, cacheReadTokens: 64, cacheWriteTokens: 8, contextPercentage: 12.5 },
  { kind: 'stop', stopReason: 'TOOL_USE' },
]

const payloads = []
for (const evt of events) {
  const payload = wireToOpenAiChunk(evt, openAiState)
  if (payload !== undefined) payloads.push(JSON.parse(payload))
}

eq(payloads.length, 7, '7 个事件吐 7 个 SSE 负载（tool-stop/usage/stop 不吐）')
eq(payloads[0].choices[0].delta, { role: 'assistant', reasoning_content: 'thinking… ' }, '首个 delta 带 role + reasoning_content')
eq(payloads[0].object, 'chat.completion.chunk', 'object 是 chat.completion.chunk')
eq(payloads[0].created, 1700000000, 'created 来自 state')
eq(payloads[1].choices[0].delta, { reasoning_content: 'more' }, 'reasoning 增量逐事件转发')
eq(payloads[2].choices[0].delta, { content: 'Hello' }, 'text 增量逐事件转发')
eq(payloads[3].choices[0].delta, { content: ' world' }, 'text 第二段')
eq(
  payloads[4].choices[0].delta,
  { tool_calls: [{ index: 0, id: 'tooluse_1', type: 'function', function: { name: 'read_file', arguments: '' } }] },
  'tool-start 建块：index/id/name，arguments 空',
)
eq(
  payloads[5].choices[0].delta,
  { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
  'tool-delta 追加参数片段（只带 index + arguments）',
)
eq(
  payloads[6].choices[0].delta,
  { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
  'tool-delta 第二段',
)
ok(payloads.every(p => p.choices[0].finish_reason === null), '中间 chunk 的 finish_reason 都是 null')
eq(openAiState.text, 'Hello world', 'state 累积可见文本')
eq(openAiState.reasoning, 'thinking… more', 'state 累积 reasoning')
eq(openAiState.contextPercentage, 12.5, 'state 记下 contextPercentage')

const finishPayload = JSON.parse(wireFinish(openAiState, 'TOOL_USE'))
eq(finishPayload.choices[0].finish_reason, 'tool_calls', 'TOOL_USE -> tool_calls')
eq(finishPayload.choices[0].delta, {}, '收尾 chunk 的 delta 为空对象')
eq(finishPayload.usage.prompt_tokens, 120, 'usage.prompt_tokens = inputTokens')
eq(finishPayload.usage.completion_tokens, 30, 'usage.completion_tokens = outputTokens')
eq(finishPayload.usage.total_tokens, 150, 'usage.total_tokens 是两者之和')
eq(finishPayload.usage.prompt_tokens_details.cached_tokens, 64, 'prompt_tokens_details.cached_tokens = cacheReadTokens')

const finalResponse = wireToOpenAiResponse(openAiState)
eq(finalResponse.object, 'chat.completion', '非流式 object')
eq(finalResponse.choices[0].message.content, 'Hello world', '非流式 message.content')
eq(finalResponse.choices[0].message.reasoning_content, 'thinking… more', '非流式带 reasoning_content')
eq(
  finalResponse.choices[0].message.tool_calls,
  [{ id: 'tooluse_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  '非流式 tool_calls 按 id 归并成完整 arguments',
)
eq(finalResponse.choices[0].finish_reason, 'tool_calls', '非流式 finish_reason')

// 逐个 stopReason 的映射
log('  -- stopReason 映射 --')
const stopCases = [
  ['END_TURN', 'stop'],
  ['TOOL_USE', 'tool_calls'],
  ['MAX_TOKENS', 'length'],
  ['MODEL_CONTEXT_WINDOW_EXCEEDED', 'length'],
  ['CONTENT_FILTERED', 'content_filter'],
  ['PAUSE_TURN', 'stop'],
]
for (const [raw, expected] of stopCases) {
  const st = newOpenAiState({ id: 'x', model: 'm', created: 0 })
  if (raw === 'TOOL_USE') {
    wireToOpenAiChunk({ kind: 'tool-start', id: 'tooluse_t', name: 'noop' }, st)
  }
  const payload = JSON.parse(wireFinish(st, raw))
  eq(payload.choices[0].finish_reason, expected, `${raw} -> ${expected}`)
  if (raw === 'MODEL_CONTEXT_WINDOW_EXCEEDED') {
    eq(payload.kiro.code, 'MODEL_CONTEXT_WINDOW_EXCEEDED', '上下文超限带 code 提示')
    ok(/context window/i.test(payload.kiro.message), '上下文超限的提示文本说明原因')
  }
}

// 有工具调用却报 END_TURN：不能报 stop，否则客户端不执行工具
const toolThenEndTurn = newOpenAiState({ id: 'x', model: 'm', created: 0 })
wireToOpenAiChunk({ kind: 'tool-start', id: 'tooluse_z', name: 'noop' }, toolThenEndTurn)
eq(
  JSON.parse(wireFinish(toolThenEndTurn, 'END_TURN')).choices[0].finish_reason,
  'tool_calls',
  '有工具块时 END_TURN 仍报 tool_calls（否则工具循环静默死掉）',
)

// 无 role 的收尾：一次都没吐过 delta 时补 role
const bareState = newOpenAiState({ id: 'x', model: 'm', created: 0 })
eq(JSON.parse(wireFinish(bareState, 'END_TURN')).choices[0].delta, { role: 'assistant' }, '从未吐过 delta 时收尾补 role')

// error 事件：不抛，转成 error 负载
const errState = newOpenAiState({ id: 'x', model: 'm', created: 0 })
const errPayload = JSON.parse(wireToOpenAiChunk({ kind: 'error', message: 'boom', code: 'AUTH' }, errState))
eq(errPayload.error.code, 'AUTH', 'error 事件转成 SSE error 负载（不抛）')
eq(errPayload.error.message, 'boom', 'error 负载带 message')

// ===========================================================================
log('')
log('== 3. Anthropic -> wire ==')

const anthropicBody = {
  model: 'claude-sonnet-4-5',
  stream: true,
  max_tokens: 999999,
  system: [
    { type: 'text', text: 'You are careful.' },
    { type: 'text', text: 'Answer in English.' },
  ],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'b.txt' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: [{ type: 'text', text: 'B contents' }],
        },
        { type: 'text', text: 'continue' },
      ],
    },
  ],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  tool_choice: { type: 'any' },
}

const wire2 = anthropicToWire(anthropicBody, {
  modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  conversationId: 'conv-anthropic-1',
  maxTokensBounds: { minimum: 1024, maximum: 64000 },
})
const wire2Body = wire2.body
const wire2History = wire2Body.conversationState.history
const wire2Current = wire2Body.conversationState.currentMessage.userInputMessage

eq(wire2.stream, true, 'Anthropic stream 透传')
eq(
  wire2Body.additionalModelRequestFields,
  { max_tokens: 64000 },
  'max_tokens 被 ctx.maxTokensBounds 夹到上界',
)
ok(wire2Body.conversationState.history.length === 2, 'Anthropic history 2 条（user/assistant，以 assistant 结尾）')
eq(
  wire2History[0].userInputMessage.content,
  'You are careful.\n\nAnswer in English.\n\nlook',
  'system block 数组拼成前缀',
)
eq(
  wire2History[0].userInputMessage.images,
  [{ format: 'jpeg', source: { bytes: '/9j/4AAQ' } }],
  'base64 image source 转 ImageBlock',
)
eq(
  wire2History[1].assistantResponseMessage.toolUses,
  [{ toolUseId: 'toolu_01', name: 'read_file', input: { path: 'b.txt' } }],
  'tool_use -> toolUses',
)
eq(wire2History[1].assistantResponseMessage.content, 'reading', 'thinking block 被丢弃，text 保留')
eq(
  wire2Current.userInputMessageContext.toolResults,
  [{ toolUseId: 'toolu_01', content: [{ text: 'B contents' }], status: 'success' }],
  'tool_result -> toolResults',
)
eq(wire2Current.content, 'continue', 'currentMessage 是最后一条 user 的文本')
eq(
  wire2Current.userInputMessageContext.tools,
  [{
    toolSpecification: {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { json: { type: 'object', properties: { path: { type: 'string' } } } },
    },
  }],
  'input_schema 映射到 inputSchema.json',
)
ok(wire2Body.additionalModelRequestFields.tool_choice === undefined, 'tool_choice 被忽略')

// system 为字符串
const strSystem = anthropicToWire({
  model: 'm',
  max_tokens: 100,
  system: 'plain system',
  messages: [{ role: 'user', content: 'hi' }],
}, { modelId: 'm' })
eq(
  strSystem.body.conversationState.currentMessage.userInputMessage.content,
  'plain system\n\nhi',
  'system 为字符串时同样前置',
)

// image url source 拒绝
throwsCode(
  () => anthropicToWire({
    model: 'm',
    max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
  }, { modelId: 'm' }),
  'UNSUPPORTED_CONTENT',
  'image source.type=url 抛 UNSUPPORTED_CONTENT',
)

// ===========================================================================
log('')
log('== 4. wire 事件 -> Anthropic SSE ==')

const anthropicState = newAnthropicState({ id: 'msg_test', model: 'claude-sonnet-4-5' })
const frames = []

const startPayload = JSON.parse(anthropicStart(anthropicState))
eq(startPayload.type, 'message_start', 'message_start 类型')
eq(startPayload.message.id, 'msg_test', 'message_start 带 id')
eq(startPayload.message.role, 'assistant', 'message_start.role = assistant')
eq(startPayload.message.content, [], 'message_start.content 为空数组')
eq(startPayload.message.usage, { input_tokens: 0, output_tokens: 0 }, 'message_start usage 先给 0')

const anthropicEvents = [
  { kind: 'reasoning', text: 'thinking' },
  { kind: 'text', text: 'Hello' },
  { kind: 'text', text: ' world' },
  { kind: 'tool-start', id: 'tooluse_9', name: 'read_file' },
  { kind: 'tool-delta', id: 'tooluse_9', argumentsDelta: '{"path":"c.txt"}' },
  { kind: 'tool-stop', id: 'tooluse_9' },
  { kind: 'usage', inputTokens: 200, outputTokens: 40, cacheReadTokens: 128, cacheWriteTokens: 16 },
  { kind: 'stop', stopReason: 'TOOL_USE' },
]

for (const evt of anthropicEvents) {
  const frame = wireToAnthropicEvent(evt, anthropicState)
  if (frame !== undefined) frames.push(frame)
  // 队列里可能还压着被推迟的帧，全部排出以保证顺序完整。
  while (anthropicState.queue.length > 0) {
    frames.push(anthropicState.queue.shift())
  }
}

const frameTypes = frames.map(f => f.event)
eq(
  frameTypes,
  [
    'content_block_start',   // thinking block
    'content_block_delta',   // thinking_delta
    'content_block_stop',    // 关 thinking，开 text
    'content_block_start',   // text block
    'content_block_delta',   // Hello
    'content_block_delta',   // ' world'
    'content_block_stop',    // 关 text，开 tool_use
    'content_block_start',   // tool_use block
    'content_block_delta',   // input_json_delta
    'content_block_stop',    // tool-stop 关块
  ],
  'SSE 帧序列：thinking -> text -> tool_use，块按顺序关/开',
)

const started = frames.filter(f => f.event === 'content_block_start').map(f => JSON.parse(f.data))
eq(started[0].content_block.type, 'thinking', '第一个块是 thinking')
eq(started[0].index, 0, 'thinking block index 0')
eq(started[1].content_block.type, 'text', '第二个块是 text')
eq(started[1].index, 1, 'text block index 1')
eq(started[2].content_block.type, 'tool_use', '第三个块是 tool_use')
eq(started[2].index, 2, 'tool_use block index 2')
eq(started[2].content_block.id, 'tooluse_9', 'tool_use block 带 wire id')
eq(started[2].content_block.name, 'read_file', 'tool_use block 带 name')
eq(started[2].content_block.input, {}, 'tool_use block input 起始为空对象')

const deltas = frames.filter(f => f.event === 'content_block_delta').map(f => JSON.parse(f.data))
eq(deltas[0].delta, { type: 'thinking_delta', thinking: 'thinking' }, 'thinking_delta')
eq(deltas[1].delta, { type: 'text_delta', text: 'Hello' }, 'text_delta 增量')
eq(deltas[2].delta, { type: 'text_delta', text: ' world' }, 'text_delta 第二段')
eq(
  deltas[3].delta,
  { type: 'input_json_delta', partial_json: '{"path":"c.txt"}' },
  'input_json_delta 增量',
)
eq(deltas[3].index, 2, 'input_json_delta 指向 tool_use 块 index')

const stops = frames.filter(f => f.event === 'content_block_stop').map(f => JSON.parse(f.data))
eq(stops.map(s => s.index), [0, 1, 2], '三个 content_block_stop 依次关闭 0/1/2')

const tail = anthropicStop(anthropicState, 'TOOL_USE').map(f => ({ event: f.event, data: JSON.parse(f.data) }))
eq(tail.map(f => f.event), ['message_delta', 'message_stop'], '收尾是 message_delta + message_stop')
eq(tail[0].data.delta, { stop_reason: 'tool_use', stop_sequence: null }, 'TOOL_USE -> tool_use')
eq(tail[0].data.usage.input_tokens, 200, 'usage.input_tokens')
eq(tail[0].data.usage.output_tokens, 40, 'usage.output_tokens')
eq(tail[0].data.usage.cache_read_input_tokens, 128, 'cache_read_input_tokens 映射')
eq(tail[0].data.usage.cache_creation_input_tokens, 16, 'cache_creation_input_tokens 映射')
eq(tail[1].data, { type: 'message_stop' }, 'message_stop 负载')

log('  -- Anthropic stopReason 映射 --')
const anthropicStopCases = [
  ['END_TURN', 'end_turn'],
  ['TOOL_USE', 'tool_use'],
  ['MAX_TOKENS', 'max_tokens'],
  ['MODEL_CONTEXT_WINDOW_EXCEEDED', 'max_tokens'],
  ['CONTENT_FILTERED', 'end_turn'],
  ['PAUSE_TURN', 'end_turn'],
]
for (const [raw, expected] of anthropicStopCases) {
  const st = newAnthropicState({ id: 'x', model: 'm' })
  if (raw === 'TOOL_USE') wireToAnthropicEvent({ kind: 'tool-start', id: 'tooluse_q', name: 'noop' }, st)
  const out = anthropicStop(st, raw)
  const deltaFrame = out.find(f => f.event === 'message_delta')
  eq(JSON.parse(deltaFrame.data).delta.stop_reason, expected, `${raw} -> ${expected}`)
  if (raw === 'MODEL_CONTEXT_WINDOW_EXCEEDED') {
    eq(JSON.parse(deltaFrame.data).kiro.code, 'MODEL_CONTEXT_WINDOW_EXCEEDED', '上下文超限带 code')
  }
}

// 有 tool_use 块却报 END_TURN：不能报 end_turn
const forced = newAnthropicState({ id: 'x', model: 'm' })
wireToAnthropicEvent({ kind: 'tool-start', id: 'tooluse_f', name: 'noop' }, forced)
eq(
  JSON.parse(anthropicStop(forced, 'END_TURN').find(f => f.event === 'message_delta').data).delta.stop_reason,
  'tool_use',
  '有 tool_use 块时 END_TURN 仍报 tool_use',
)

// 未关的块在收尾时被关掉
const unclosed = newAnthropicState({ id: 'x', model: 'm' })
wireToAnthropicEvent({ kind: 'text', text: 'partial' }, unclosed)
while (unclosed.queue.length > 0) unclosed.queue.shift()
const unclosedTail = anthropicStop(unclosed, 'END_TURN')
eq(unclosedTail[0].event, 'content_block_stop', '收尾先补 content_block_stop')
eq(unclosedTail[1].event, 'message_delta', '然后 message_delta')
eq(unclosedTail[2].event, 'message_stop', '最后 message_stop')

// error 事件
const errAnthropic = newAnthropicState({ id: 'x', model: 'm' })
const errFrame = wireToAnthropicEvent({ kind: 'error', message: 'boom', code: 'RATE_LIMIT' }, errAnthropic)
eq(errFrame.event, 'error', 'error 事件 -> SSE error 帧（不抛）')
eq(JSON.parse(errFrame.data).error.message, 'boom', 'error 帧带 message')

// ===========================================================================
log('')
log('== 5. Anthropic 非流式响应（anthropicResponse）==')

// 同一串事件走非流式：content 按出现顺序还原 thinking -> text -> tool_use。
const nonStream = newAnthropicState({ id: 'msg_nonstream', model: 'claude-sonnet-4-5' })
for (const evt of anthropicEvents) wireToAnthropicEvent(evt, nonStream)
const response = anthropicResponse(nonStream)

eq(response.type, 'message', 'type = message')
eq(response.role, 'assistant', 'role = assistant')
eq(response.id, 'msg_nonstream', 'id 来自 state')
eq(response.model, 'claude-sonnet-4-5', 'model 回显')
eq(response.stop_sequence, null, 'stop_sequence = null')
eq(
  response.content.map(block => block.type),
  ['thinking', 'text', 'tool_use'],
  'content 按出现顺序还原（不按 type 分组）',
)
eq(response.content[0], { type: 'thinking', thinking: 'thinking', signature: '' }, 'thinking 块累积完整文本')
eq(response.content[1], { type: 'text', text: 'Hello world' }, 'text 块累积完整文本')
eq(
  response.content[2],
  { type: 'tool_use', id: 'tooluse_9', name: 'read_file', input: { path: 'c.txt' } },
  'tool_use 的 input 由累积的 partial_json 解析',
)
eq(response.stop_reason, 'tool_use', '非流式 stop_reason 与流式一致（TOOL_USE -> tool_use）')
eq(response.usage.input_tokens, 200, '非流式 usage.input_tokens')
eq(response.usage.output_tokens, 40, '非流式 usage.output_tokens')
eq(response.usage.cache_read_input_tokens, 128, '非流式 cache_read_input_tokens')
eq(response.usage.cache_creation_input_tokens, 16, '非流式 cache_creation_input_tokens')

// 空轮：Anthropic 不允许 content 为空数组
const emptyState = newAnthropicState({ id: 'msg_empty', model: 'm' })
const emptyResponse = anthropicResponse(emptyState)
eq(emptyResponse.content, [{ type: 'text', text: '' }], '没有 content block 时给一个空 text 块')
eq(emptyResponse.stop_reason, 'end_turn', '空轮默认 end_turn')

// 半截 JSON：解析失败给 {}，不抛
const brokenState = newAnthropicState({ id: 'msg_broken', model: 'm' })
wireToAnthropicEvent({ kind: 'tool-start', id: 'tooluse_b', name: 'noop' }, brokenState)
wireToAnthropicEvent({ kind: 'tool-delta', id: 'tooluse_b', argumentsDelta: '{"a":' }, brokenState)
const brokenResponse = anthropicResponse(brokenState)
eq(brokenResponse.content[0].input, {}, '半截 JSON 的 input 解析失败给 {}，不抛')
eq(brokenResponse.stop_reason, 'tool_use', '有 tool_use 块时 stop_reason 报 tool_use')

// 空 text 块不混进 content
const blankState = newAnthropicState({ id: 'msg_blank', model: 'm' })
wireToAnthropicEvent({ kind: 'text', text: '' }, blankState)
wireToAnthropicEvent({ kind: 'text', text: 'real' }, blankState)
eq(anthropicResponse(blankState).content, [{ type: 'text', text: 'real' }], '空 delta 不产生空 text 块')

// ===========================================================================
log('')
log(`== 结果：${passed} passed, ${failed} failed ==`)
if (failed > 0) process.exitCode = 1
