/**
 * 空响应换模型的离线验证：注入的 post 先回空流、再回内容，断言 stream() 自己就换过去了。
 *
 * Run: node .scratch/fallback-test.mjs
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

const streamOf = frames => ({
  async *[Symbol.asyncIterator]() { for (const chunk of frames) yield chunk },
})

const emptyStream = [frame({ ':event-type': 'contextUsageEvent' }, { contextUsagePercentage: 3.2 })]
const contentStream = [
  frame({ ':event-type': 'assistantResponseEvent' }, { content: '我是备胎模型' }),
  frame({ ':event-type': 'contextUsageEvent' }, { contextUsagePercentage: 3.2 }),
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
      const modelId = JSON.parse(spec.body).conversationState.currentMessage.userInputMessage.modelId
      calls.push(modelId)
      const next = script.shift()
      if (next === undefined) throw new Error('script exhausted')
      return next
    },
    sleep: async () => {},
  })
  // 目录直接注入，避免真实发现请求
  client.catalogCache.set('us-east-1\u0000\u0000', {
    expiresAt: Date.now() + 60000,
    models: [
      { id: 'claude-opus-5.5', name: 'Opus 5.5', supportsEffort: false },
      { id: 'claude-sonnet-4.5', name: 'Sonnet 4.5', supportsEffort: false },
      { id: 'glm-5', name: 'GLM-5', supportsEffort: false },
    ],
  })
  return { client, calls }
}

async function drain(client, model = 'claude-opus-5.5') {
  const events = []
  for await (const event of client.stream(
    { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    { modelId: model },
  )) events.push(event)
  return events
}

const okBody = { status: 200, headers: {}, body: streamOf(contentStream) }
const emptyBody = { status: 200, headers: {}, body: streamOf(emptyStream) }

// ---------------------------------------------------------------------------
// 1. 选中模型空响应 -> 自动换到下一个候选，并记录 lastFallback
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([emptyBody, okBody])
  const events = await drain(client)
  const text = events.filter(event => event.kind === 'text').map(event => event.text).join('')
  check('换模型后拿到正文', text === '我是备胎模型', text)
  check('先试选中的模型', calls[0] === 'claude-opus-5.5', JSON.stringify(calls))
  check('空响应后换到候选', calls[1] === 'claude-sonnet-4.5', JSON.stringify(calls))
  check('记录 lastFallback', client.lastFallback?.to === 'claude-sonnet-4.5', JSON.stringify(client.lastFallback))
  check('有 stop 事件', events.at(-1)?.kind === 'stop', JSON.stringify(events.at(-1)))
}

// ---------------------------------------------------------------------------
// 2. 选中模型正常 -> 不换模型，也不写 lastFallback
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([okBody])
  const events = await drain(client)
  check('正常时不换模型', calls.length === 1 && calls[0] === 'claude-opus-5.5', JSON.stringify(calls))
  check('正常时无 lastFallback', client.lastFallback === undefined)
  check('正常时有正文', events.some(event => event.kind === 'text'))
}

// ---------------------------------------------------------------------------
// 3. 关闭 fallbackOnEmpty -> 只试一次，如实报空
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([emptyBody], { fallbackOnEmpty: false })
  const events = await drain(client)
  check('关闭后只发一次', calls.length === 1, JSON.stringify(calls))
  check('关闭后仍是空回合（交给上层报 CONTENT_FILTERED）',
    !events.some(event => event.kind === 'text') && events.at(-1)?.kind === 'stop',
    JSON.stringify(events))
}

// ---------------------------------------------------------------------------
// 4. 自定义候选表：只按给定顺序
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([emptyBody, okBody], { fallbackModels: ['glm-5'] })
  const events = await drain(client)
  check('自定义候先生效', calls[1] === 'glm-5', JSON.stringify(calls))
  check('自定义候选也拿到正文', events.some(event => event.kind === 'text'))
}

// ---------------------------------------------------------------------------
// 5. 所有候选都空 -> 一次空回合，不无限换
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([emptyBody, emptyBody, emptyBody, emptyBody, emptyBody, emptyBody, emptyBody, emptyBody])
  const events = await drain(client)
  check('候选表有界（不超过目录模型数）', calls.length <= 3, JSON.stringify(calls))
  check('全空时仍是空回合', !events.some(event => event.kind === 'text'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
