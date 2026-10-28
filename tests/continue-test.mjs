/**
 * 自动续写的离线验证：只想不做（reasoning 有、可见内容无）时应当自己再问一次，
 * 而不是让用户手动输入"继续"。
 *
 * Run: node .scratch/continue-test.mjs
 */

import { KiroClient } from '../lib/kiro-client.js'

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

function frame(headers, payload) {
  const parts = Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name, 'utf8')
    const v = Buffer.from(value, 'utf8')
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), Buffer.from([(v.length >> 8) & 0xff, v.length & 0xff]), v])
  })
  const headerBuf = Buffer.concat(parts)
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8')
  const total = 12 + headerBuf.length + payloadBuf.length + 4
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(total, 0)
  prelude.writeUInt32BE(headerBuf.length, 4)
  return Buffer.concat([prelude, headerBuf, payloadBuf, Buffer.alloc(4)])
}
const streamOf = frames => ({ async *[Symbol.asyncIterator]() { for (const chunk of frames) yield chunk } })

const reasoningOnly = [
  frame({ ':event-type': 'reasoningContentEvent' }, { text: '让我想想…' }),
  frame({ ':event-type': 'metadataEvent' }, { stopReason: 'END_TURN' }),
]
const withText = [
  frame({ ':event-type': 'assistantResponseEvent' }, { content: '这就开始。' }),
  frame({ ':event-type': 'metadataEvent' }, { stopReason: 'END_TURN' }),
]
const toolCall = [
  frame({ ':event-type': 'toolUseEvent' }, { name: 'read', toolUseId: 'tu_1' }),
  frame({ ':event-type': 'toolUseEvent' }, { input: '{"file_path":"a"}', name: 'read', toolUseId: 'tu_1' }),
  frame({ ':event-type': 'toolUseEvent' }, { name: 'read', stop: true, toolUseId: 'tu_1' }),
]

function buildClient(script, options = {}) {
  const calls = []
  const client = new KiroClient({
    options: () => options,
    store: {
      directory: 'unused',
      active: async () => ({ credential: { accessToken: 'ksk_test', method: 'api_key', region: 'us-east-1' }, id: 'a', label: 'A' }),
      read: async () => ({ accounts: [], activeId: null }),
      describe: async () => ({ activeId: null, accounts: [] }),
      clear: async () => {},
    },
    post: async spec => {
      const body = JSON.parse(spec.body)
      const history = body.conversationState.history ?? []
      calls.push({
        userMessages: history.filter(entry => 'userInputMessage' in entry).length,
        lastUser: history.filter(entry => 'userInputMessage' in entry).at(-1)?.userInputMessage.content ?? '',
        // 续写提示语是新的 currentMessage，不进 history
        current: body.conversationState.currentMessage.userInputMessage.content,
      })
      const next = script.shift()
      if (next === undefined) throw new Error('script exhausted')
      return next
    },
    sleep: async () => {},
  })
  client.catalogCache.set('us-east-1\u0000\u0000', {
    expiresAt: Date.now() + 60000,
    models: [{ id: 'claude-sonnet-4.5', name: 'Sonnet 4.5', supportsEffort: false }],
  })
  return { client, calls }
}

async function drain(client) {
  const events = []
  for await (const event of client.stream(
    { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: [{ type: 'text', text: '开始吧' }] }] },
    { modelId: 'claude-sonnet-4.5' },
  )) events.push(event)
  return events
}

const response = frames => ({ status: 200, headers: {}, body: streamOf(frames) })

// ---------------------------------------------------------------------------
// 1. 只想不做 -> 自动补一轮
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([response(reasoningOnly), response(withText)])
  const events = await drain(client)
  const text = events.filter(event => event.kind === 'text').map(event => event.text).join('')
  check('自动续写拿到正文', text === '这就开始。', text)
  check('发了两轮请求', calls.length === 2, calls.length)
  check('第二轮把 continue 作为当前轮', calls[1].current === 'continue', calls[1].current)
}

// ---------------------------------------------------------------------------
// 2. 有正文 -> 不续写
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([response(withText)])
  const events = await drain(client)
  check('有正文时不续写', calls.length === 1, calls.length)
  check('事件里没有 continue', !calls.some(call => call.current === 'continue'))
  check('正文正确', events.filter(e => e.kind === 'text').map(e => e.text).join('') === '这就开始。')
}

// ---------------------------------------------------------------------------
// 3. 调了工具 -> 不续写（等 Harness 执行工具）
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([response(toolCall)])
  const events = await drain(client)
  check('调工具时不续写', calls.length === 1, calls.length)
  check('finish 是 tool-calls 或 stop', ['tool-calls', 'stop'].includes(events.at(-1)?.stopReason === 'TOOL_USE' ? 'tool-calls' : 'stop'), JSON.stringify(events.at(-1)))
}

// ---------------------------------------------------------------------------
// 4. 一直只想不做 -> 有上限，不会无限续写
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([
    response(reasoningOnly), response(reasoningOnly), response(reasoningOnly), response(reasoningOnly),
  ])
  await drain(client)
  check('续写有上限（默认 2 次 -> 共 3 轮）', calls.length === 3, calls.length)
}

// ---------------------------------------------------------------------------
// 5. 关闭 autoContinue -> 只发一轮
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([response(reasoningOnly)], { autoContinue: false })
  const events = await drain(client)
  check('关闭后只发一轮', calls.length === 1, calls.length)
  check('关闭后仍以 stop 收尾', events.at(-1)?.kind === 'stop')
}

// ---------------------------------------------------------------------------
// 6. 自定义上限
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([
    response(reasoningOnly), response(reasoningOnly), response(reasoningOnly), response(reasoningOnly),
  ], { maxContinuations: 1 })
  await drain(client)
  check('maxContinuations=1 -> 共 2 轮', calls.length === 2, calls.length)
}

// ---------------------------------------------------------------------------
// 7. 续写时不能先吐出上一轮的 stop：否则适配器提前收尾，正文落在 finish 之后
//    （真实症状：最后一轮只有思考、没有正文就结束了）
// ---------------------------------------------------------------------------
{
  const { client } = buildClient([response(reasoningOnly), response(withText)])
  const events = await drain(client)
  const kinds = events.map(event => event.kind)
  const firstStop = kinds.indexOf('stop')
  const firstText = kinds.indexOf('text')
  check('续写时只出现一个 stop', kinds.filter(kind => kind === 'stop').length === 1, kinds.join(','))
  check('stop 在正文之后', firstText >= 0 && firstStop > firstText, kinds.join(','))
  check('usage 也只出现一次', kinds.filter(kind => kind === 'usage').length === 1, kinds.join(','))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
