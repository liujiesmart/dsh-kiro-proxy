/**
 * Adapter contract test: prove the chunk protocol, not the network.
 *
 * A stub client feeds normalized events, so what is asserted here is exactly
 * what the Harness consumes: blocks start before they grow, tool calls close,
 * usage is summed into the four disjoint buckets, and an unknown stop reason
 * fails the turn instead of reporting success.
 *
 * Run: node .scratch/adapter-test.mjs
 */

import { KiroProxyAdapter, finishReason } from '../lib/adapter.js'

let pass = 0
let fail = 0
const check = (name, condition, detail) => {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
    return
  }
  fail += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const adapterPolicy = new KiroProxyAdapter({ client: stubClient([]), provider: 'kiro-proxy' }).providerRetryPolicy()

function stubClient(events, models = []) {
  return {
    connection: () => ({ enabledModels: undefined }),
    models: async () => models,
    usage: async () => ({ plan: 'KIRO', rows: [], fetchedAt: 0 }),
    clear: () => {},
    stream: async function* () {
      for (const event of events) yield event
    },
  }
}

const models = [
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200000,
    maxTokens: 64000,
    inputModalities: ['text', 'image'],
    supportsEffort: false,
  },
  {
    id: 'claude-opus-5.5',
    name: 'Claude Opus 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    supportsEffort: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
    effortSchemaPath: 'output_config',
    maxTokensBounds: { minimum: 1024, maximum: 128000 },
  },
]

// ---------------------------------------------------------------------------
// 1. providerInfo / retry policy / image target
// ---------------------------------------------------------------------------
{
  const adapter = new KiroProxyAdapter({ client: stubClient([]), provider: 'kiro-proxy', displayName: 'Kiro Proxy' })
  const info = adapter.providerInfo('kiro-proxy')
  check('providerInfo.id 与路由一致', info.id === 'kiro-proxy', info.id)
  check('providerInfo.name 非空', info.name === 'Kiro Proxy', info.name)
  const policy = adapter.providerRetryPolicy('kiro-proxy')
  check('retry 不含 QUOTA', !policy.retryableCodes.includes('QUOTA'), policy.retryableCodes.join(','))
  check('retry 不含 CONTEXT_WINDOW_EXCEEDED', !policy.retryableCodes.includes('CONTEXT_WINDOW_EXCEEDED'))
  check('retry 含 RATE_LIMIT', policy.retryableCodes.includes('RATE_LIMIT'))
  const target = adapter.imageRequestTarget()
  check('图片目标 8000x8000/3.75MB', target.width === 8000 && target.maxBytes === 3750000, JSON.stringify(target))
}

// ---------------------------------------------------------------------------
// 2. resolveModel：目录命中 / 未知 id 仍可解析 / 上下文上限
// ---------------------------------------------------------------------------
{
  const adapter = new KiroProxyAdapter({ client: stubClient([], models), provider: 'kiro-proxy' })
  const known = await adapter.resolveModel('kiro-proxy', 'claude-opus-5.5')
  check('已知模型带 effort', known.reasoning.efforts.map(e => e.id).join(',') === 'low,medium,high,xhigh,max', JSON.stringify(known.reasoning))
  check('已知模型默认 effort', known.reasoning.defaultEffort === 'medium', known.reasoning.defaultEffort)
  // 目录报 1M，但上报给 Harness 的默认封顶 200k：Kiro 对长报文会回 "Input is too long."，
  // 报满 1M 等于告诉 Harness 不用压缩。
  check('已知模型上下文默认封顶 200k', known.context.contextWindow === 200000, known.context?.contextWindow)
  const uncapped = new KiroProxyAdapter({
    client: stubClient([], models), provider: 'kiro-proxy', cap: () => 1_000_000,
  })
  const full = await uncapped.resolveModel('kiro-proxy', 'claude-opus-5.5')
  check('显式配置可放开到目录值', full.context.contextWindow === 1000000, full.context.contextWindow)
  check('已知模型 inputModalities', known.inputModalities.join('+') === 'text+image', JSON.stringify(known.inputModalities))
  check('systemPromptUpdate 是 in-history', known.systemPromptUpdate === 'in-history', known.systemPromptUpdate)

  const unknown = await adapter.resolveModel('kiro-proxy', 'some-future-model')
  check('未知模型仍可解析', unknown.id === 'some-future-model', unknown.id)
  check('未知模型用回退 effort 表', unknown.reasoning.efforts.map(e => e.id).join(',') === 'off,low,medium,high', JSON.stringify(unknown.reasoning.efforts))

  const capped = new KiroProxyAdapter({
    client: stubClient([], models),
    provider: 'kiro-proxy',
    cap: () => 300000,
  })
  const lowered = await capped.resolveModel('kiro-proxy', 'claude-opus-5.5')
  check('maxContextWindow 只能调低', lowered.context.contextWindow === 300000, lowered.context.contextWindow)
}

// ---------------------------------------------------------------------------
// 3. listModels 按 enabledModels 过滤
// ---------------------------------------------------------------------------
{
  const adapter = new KiroProxyAdapter({ client: stubClient([], models), provider: 'kiro-proxy' })
  const all = await adapter.listModels('kiro-proxy')
  check('listModels 全量', all.length === 2, all.length)
  check('listModels 形状', all[0].provider === 'kiro-proxy' && typeof all[0].name === 'string', JSON.stringify(all[0]))

  const filtered = new KiroProxyAdapter({
    client: {
      ...stubClient([], models),
      connection: () => ({ enabledModels: ['claude-sonnet-4.5'] }),
    },
    provider: 'kiro-proxy',
  })
  const only = await filtered.listModels('kiro-proxy')
  check('enabledModels 过滤生效', only.length === 1 && only[0].id === 'claude-sonnet-4.5', JSON.stringify(only.map(m => m.id)))
}

// ---------------------------------------------------------------------------
// 4. stream：文本 / reasoning / 工具 的块协议
// ---------------------------------------------------------------------------
async function collect(events) {
  const adapter = new KiroProxyAdapter({ client: stubClient(events, models), provider: 'kiro-proxy' })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'kiro-proxy', model: 'claude-sonnet-4.5', messages: [] })) {
    chunks.push(chunk)
  }
  return chunks
}

{
  const chunks = await collect([
    { kind: 'text', text: 'Hello ' },
    { kind: 'reasoning', text: '思考' },
    { kind: 'text', text: 'world' },
    { kind: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  const kinds = chunks.map(chunk => chunk.type).join(',')
  // 相邻的 text 增量归入同一个块（reasoning 会把它们切开），所以是 2 个块、2 个 block-end。
  check('块序列', kinds === 'block-start,text-delta,block-start,reasoning-delta,text-delta,block-end,block-end,usage,finish', kinds)
  const starts = chunks.filter(chunk => chunk.type === 'block-start')
  check('两个块各自 index 唯一', new Set(starts.map(chunk => chunk.index)).size === 2, JSON.stringify(starts.map(c => c.index)))
  const textEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
  check('text 块内容合并', textEnd.block.text === 'Hello world', textEnd.block.text)
  const reasoningEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  check('reasoning 块内容', reasoningEnd.block.text === '思考', reasoningEnd.block.text)
  const usage = chunks.find(chunk => chunk.type === 'usage')
  check('usage 四桶求和', usage.usage.totalTokens === 20, JSON.stringify(usage.usage))
  const finish = chunks.at(-1)
  check('finish=stop', finish.reason.kind === 'stop', JSON.stringify(finish.reason))
}

// ---------------------------------------------------------------------------
// 5. stream：工具调用块
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-start', id: 'tu_1', name: 'fs_read' },
    { kind: 'tool-delta', id: 'tu_1', argumentsDelta: '{"p":' },
    { kind: 'tool-delta', id: 'tu_1', argumentsDelta: '"a"}' },
    { kind: 'tool-stop', id: 'tu_1' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'TOOL_USE' },
  ])
  const end = chunks.find(chunk => chunk.type === 'block-end')
  check('工具块完整参数', end.block.arguments === '{"p":"a"}', end.block.arguments)
  check('工具块保留 name', end.block.name === 'fs_read', end.block.name)
  check('finish=tool-calls', chunks.at(-1).reason.kind === 'tool-calls', JSON.stringify(chunks.at(-1).reason))
  const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  check('tool-call-delta 数量', deltas.length === 3, deltas.length)
}

// ---------------------------------------------------------------------------
// 6. 流结束时工具仍开着 -> 补 block-end
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-start', id: 'tu_2', name: 'shell' },
    { kind: 'tool-delta', id: 'tu_2', argumentsDelta: '{"cmd":"ls"}' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'TOOL_USE' },
  ])
  const end = chunks.find(chunk => chunk.type === 'block-end')
  check('未关闭的工具块被补上 block-end', end?.block?.name === 'shell', JSON.stringify(end))
}

// ---------------------------------------------------------------------------
// 7. 没有 start 帧的参数增量 -> 惰性建块（部分路由把 name 与首段参数合在一帧）
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-delta', id: 'ghost', argumentsDelta: '{"a":1}' },
    { kind: 'tool-stop', id: 'ghost' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'TOOL_USE' },
  ])
  const end = chunks.find(chunk => chunk.type === 'block-end')
  check('缺 start 时惰性建块而不是整轮失败', end?.block?.arguments === '{"a":1}', JSON.stringify(end))
  check('惰性块也报 tool-calls', chunks.at(-1).reason.kind === 'tool-calls', JSON.stringify(chunks.at(-1).reason))
}

// ---------------------------------------------------------------------------
// 7b. 无 metadataEvent（stopReason=END_TURN）但发生过工具调用 -> 必须报 tool-calls
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-start', id: 'tu_x', name: 'get_time' },
    { kind: 'tool-stop', id: 'tu_x' },
    { kind: 'usage', inputTokens: 1, outputTokens: 0 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  check('已出工具块但 END_TURN -> finish tool-calls', chunks.at(-1).reason.kind === 'tool-calls', JSON.stringify(chunks.at(-1).reason))
  const end = chunks.find(chunk => chunk.type === 'block-end')
  check('空参数补成 {}', end?.block?.arguments === '{}', JSON.stringify(end?.block))
}

// ---------------------------------------------------------------------------
// 7c. 工具名在一帧里带参数时也要保留 name
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-start', id: 'tu_y', name: 'get_time' },
    { kind: 'tool-delta', id: 'tu_y', name: 'get_time', argumentsDelta: '{"tz":"Asia/Shanghai"}' },
    { kind: 'tool-stop', id: 'tu_y' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'TOOL_USE' },
  ])
  const end = chunks.find(chunk => chunk.type === 'block-end')
  check('工具块保留 name', end.block.name === 'get_time', end.block.name)
  check('参数片段拼成合法 JSON', JSON.parse(end.block.arguments).tz === 'Asia/Shanghai', end.block.arguments)
}

// ---------------------------------------------------------------------------
// 8. finishReason 映射
// ---------------------------------------------------------------------------
{
  check('END_TURN -> stop', finishReason('END_TURN').kind === 'stop')
  check('TOOL_USE -> tool-calls', finishReason('TOOL_USE').kind === 'tool-calls')
  check('MAX_TOKENS -> max-tokens', finishReason('MAX_TOKENS').kind === 'max-tokens')
  check('MODEL_CONTEXT_WINDOW_EXCEEDED -> max-tokens', finishReason('MODEL_CONTEXT_WINDOW_EXCEEDED').kind === 'max-tokens')
  // 这三条曾经都映射成 stop：用户看到半句话，界面却显示"已完成"。
  // 截断的回答必须是一个错误，而不是一个静默的成功。
  check(
    'CONTENT_FILTERED -> error 而非静默 stop',
    finishReason('CONTENT_FILTERED').kind === 'error' && finishReason('CONTENT_FILTERED').failure.code === 'CONTENT_FILTERED',
    JSON.stringify(finishReason('CONTENT_FILTERED')),
  )
  check(
    'PAUSE_TURN -> error 而非静默 stop',
    finishReason('PAUSE_TURN').kind === 'error' && finishReason('PAUSE_TURN').failure.code === 'PAUSE_TURN',
    JSON.stringify(finishReason('PAUSE_TURN')),
  )
  check(
    'STREAM_CLOSED -> error 且在可重试码里',
    finishReason('STREAM_CLOSED').kind === 'error'
      && finishReason('STREAM_CLOSED').failure.code === 'STREAM_CLOSED'
      && adapterPolicy.retryableCodes.includes('STREAM_CLOSED'),
    JSON.stringify(finishReason('STREAM_CLOSED')),
  )
  const unknown = finishReason('SOMETHING_NEW')
  check('未知 stopReason -> error 而非成功', unknown.kind === 'error' && unknown.failure.code === 'MALFORMED_RESPONSE', JSON.stringify(unknown))
}

// ---------------------------------------------------------------------------
// 8b. 没有终止帧时导出 stopReason：工具轮照旧，正文被截断要如实上报
// ---------------------------------------------------------------------------
{
  const { deriveStopReason } = await import('../lib/kiro-client.js')
  check('无终止帧 + 只有工具 -> TOOL_USE', deriveStopReason({ sawTool: true, openToolCount: 0, visibleCharacters: 0 }) === 'TOOL_USE')
  check('无终止帧 + 工具仍开着 -> TOOL_USE', deriveStopReason({ sawTool: false, openToolCount: 1, visibleCharacters: 0 }) === 'TOOL_USE')
  check('无终止帧 + 什么都没发 -> END_TURN', deriveStopReason({ sawTool: false, openToolCount: 0, visibleCharacters: 0 }) === 'END_TURN')
  // 服务端对普通回答不发 metadataEvent：收尾靠 contextUsageEvent/meteringEvent。
  // 见到这对帧 + 有正文 = 正常说完，不能判成截断（否则每条回答都会失败重试）。
  check(
    '终端用量帧 + 已发正文 -> END_TURN（服务端没有 metadataEvent 时的正常收尾）',
    deriveStopReason({ sawTool: false, openToolCount: 0, visibleCharacters: 812, sawTerminalUsage: true }) === 'END_TURN',
  )
  check(
    '终端用量帧 + 无正文 -> END_TURN',
    deriveStopReason({ sawTool: false, openToolCount: 0, visibleCharacters: 0, sawTerminalUsage: true }) === 'END_TURN',
  )
  check(
    '既没有终端用量帧也没有 metadata + 已发正文 -> STREAM_CLOSED（可疑截断，可重试）',
    deriveStopReason({ sawTool: false, openToolCount: 0, visibleCharacters: 812, sawTerminalUsage: false }) === 'STREAM_CLOSED',
  )
  check(
    '工具轮优先于用量帧判断',
    deriveStopReason({ sawTool: true, openToolCount: 0, visibleCharacters: 0, sawTerminalUsage: true }) === 'TOOL_USE',
  )
}

// ---------------------------------------------------------------------------
// 9. 目录失败时 resolveModel 仍能工作
// ---------------------------------------------------------------------------
{
  const adapter = new KiroProxyAdapter({
    client: {
      connection: () => ({}),
      models: async () => {
        throw new Error('catalog down')
      },
      usage: async () => ({ plan: 'KIRO', rows: [], fetchedAt: 0 }),
      clear: () => {},
      stream: async function* () {},
    },
    provider: 'kiro-proxy',
  })
  const info = await adapter.resolveModel('kiro-proxy', 'claude-sonnet-4.5')
  check('目录失败仍解析模型', info.id === 'claude-sonnet-4.5', info.id)
  check('目录失败用默认上下文', info.context.contextWindow === 200000, info.context.contextWindow)
}

// ---------------------------------------------------------------------------
// 10. 一个块都没产出就结束 -> EMPTY_RESPONSE（不能让 UI 一片空白）
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'usage', inputTokens: 10, outputTokens: 0 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  const finish = chunks.at(-1)
  check('空回合报 CONTENT_FILTERED（上游拒答）', finish.reason.kind === 'error' && finish.reason.failure.code === 'CONTENT_FILTERED', JSON.stringify(finish.reason))
  check('空回合的提示指向提示词而不是网络',
    /system prompt|项目指令/.test(finish.reason.failure.message),
    finish.reason.failure.message)
  check('空回合不可重试', !adapterPolicy.retryableCodes.includes('CONTENT_FILTERED'), adapterPolicy.retryableCodes.join(','))
}

// ---------------------------------------------------------------------------
// 11. 有正文时不报 EMPTY_RESPONSE
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'text', text: 'hi' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  check('有正文时 finish 仍是 stop', chunks.at(-1).reason.kind === 'stop', JSON.stringify(chunks.at(-1).reason))
}

// ---------------------------------------------------------------------------
// 12. 只有 reasoning 也算有内容（有些模型先思考再停）
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'reasoning', text: '想想' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  // 早期版本把"只有 reasoning"当成正常结束，用户看到的就是空白的一轮；
  // 现在如实报 EMPTY_RESPONSE（可重试），见第 16 组。
  check('只有 reasoning 时报 EMPTY_RESPONSE 而非静默成功',
    chunks.at(-1).reason.kind === 'error' && chunks.at(-1).reason.failure.code === 'EMPTY_RESPONSE',
    JSON.stringify(chunks.at(-1).reason))
}

// ---------------------------------------------------------------------------
// 13. 真实帧序列：空 input 帧不能让同一个 toolUseId 产出两个块
//    （否则下一步会因为两个块共用一个 id 而被服务端判 Improperly formed request）
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-start', id: 'tu_9', name: 'read' },
    { kind: 'tool-start', id: 'tu_9', name: 'read' },
    { kind: 'tool-delta', id: 'tu_9', name: 'read', argumentsDelta: '{"file_path"' },
    { kind: 'tool-delta', id: 'tu_9', name: 'read', argumentsDelta: ':"a"}' },
    { kind: 'tool-stop', id: 'tu_9' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'TOOL_USE' },
  ])
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  check('重复 start 只产出一个工具块', blocks.length === 1, blocks.length)
  check('块 id 唯一', new Set(blocks.map(block => block.id)).size === blocks.length, blocks.map(block => block.id).join(','))
  check('参数拼成合法 JSON', JSON.parse(blocks[0].arguments).file_path === 'a', blocks[0].arguments)
  const starts = chunks.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
  check('只有一个 tool-call block-start', starts.length === 1, starts.length)
}

// ---------------------------------------------------------------------------
// 14. 多个工具调用：各自成块、id 互不相同、参数各自正确
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'tool-start', id: 'tu_a', name: 'read' },
    { kind: 'tool-start', id: 'tu_a', name: 'read' },
    { kind: 'tool-delta', id: 'tu_a', argumentsDelta: '{"file_path":"package.json"}' },
    { kind: 'tool-stop', id: 'tu_a' },
    { kind: 'tool-start', id: 'tu_b', name: 'glob' },
    { kind: 'tool-start', id: 'tu_b', name: 'glob' },
    { kind: 'tool-delta', id: 'tu_b', argumentsDelta: '{"pattern":"LICENSE*"}' },
    { kind: 'tool-stop', id: 'tu_b' },
    { kind: 'tool-start', id: 'tu_c', name: 'glob' },
    { kind: 'tool-delta', id: 'tu_c', argumentsDelta: '{"pattern":"README*"}' },
    { kind: 'tool-stop', id: 'tu_c' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'TOOL_USE' },
  ])
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  check('三个工具块', blocks.length === 3, blocks.length)
  check('id 唯一', new Set(blocks.map(block => block.id)).size === 3, blocks.map(block => block.id).join(','))
  check('参数各自正确',
    JSON.parse(blocks[0].arguments).file_path === 'package.json'
    && JSON.parse(blocks[1].arguments).pattern === 'LICENSE*'
    && JSON.parse(blocks[2].arguments).pattern === 'README*',
    JSON.stringify(blocks.map(block => block.arguments)))
  check('名字正确', blocks.map(block => block.name).join(',') === 'read,glob,glob', blocks.map(block => block.name).join(','))
}

// ---------------------------------------------------------------------------
// 16. 只有 reasoning、没有正文也没有工具 -> EMPTY_RESPONSE，且可重试
//    （真实症状：这一轮"没有返回结果就结束了"）
// ---------------------------------------------------------------------------
{
  const chunks = await collect([
    { kind: 'reasoning', text: '想了很久……' },
    { kind: 'usage', inputTokens: 10, outputTokens: 5 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  const finish = chunks.at(-1)
  check('只有 reasoning -> EMPTY_RESPONSE',
    finish.reason.kind === 'error' && finish.reason.failure.code === 'EMPTY_RESPONSE',
    JSON.stringify(finish.reason))
  check('EMPTY_RESPONSE 在可重试码里', adapterPolicy.retryableCodes.includes('EMPTY_RESPONSE'), adapterPolicy.retryableCodes.join(','))
  check('提示指明要重试', /再发一次/.test(finish.reason.failure.message), finish.reason.failure.message)
}

// 17. reasoning + 正文 -> 正常 stop
{
  const chunks = await collect([
    { kind: 'reasoning', text: '想一想' },
    { kind: 'text', text: '答案' },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'stop', stopReason: 'END_TURN' },
  ])
  check('reasoning + 正文 -> stop', chunks.at(-1).reason.kind === 'stop', JSON.stringify(chunks.at(-1).reason))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
