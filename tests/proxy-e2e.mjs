/**
 * End-to-end probe of the two reverse-proxy surfaces over real HTTP.
 *
 * A stub client stands in for Kiro so this runs without a credential and without
 * spending credits: what it proves is the part the proxy owns — routing, auth,
 * body parsing, SSE framing, and the terminal frames each protocol expects.
 *
 * Run: node .scratch/proxy-e2e.mjs
 */

import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../lib/kiro-auth.js'
import { ProxyKeyStore, createProxyHandlers } from '../lib/web.js'

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

/** A client that answers from a script instead of the network. */
function stubClient(events) {
  return {
    connection: () => ({ enabledModels: ['claude-sonnet-4.5'] }),
    models: async () => [
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200000, inputModalities: ['text', 'image'], supportsEffort: false },
    ],
    usage: async () => ({ plan: 'KIRO PRO+', rows: [{ label: 'Credit', used: 113.31, limit: 2000, resetAt: 1793491200000 }], fetchedAt: Date.now() }),
    wireContext: async (modelId, effort) => ({ conversationId: 'conv-test', modelId, contextWindow: 200000, ...effort === undefined ? {} : { effort } }),
    clear: () => {},
    sendWire: async function* (body, signal, extra) {
      lastExtra = extra
      for (const event of events) yield event
    },
  }
}

const directory = await mkdtemp(join(tmpdir(), 'kiro-proxy-e2e-'))
const store = new AccountStore(directory)
const keys = new ProxyKeyStore(directory)
let lastExtra
const events = [
  { kind: 'text', text: 'EventStream ' },
  { kind: 'reasoning', text: '先解释术语。' },
  { kind: 'text', text: '与 SSE 不同。' },
  { kind: 'usage', inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { kind: 'stop', stopReason: 'END_TURN' },
]
const client = stubClient(events)

let baseUrl = ''
const handlers = createProxyHandlers({
  client,
  store,
  keys,
  updateSettings: async patch => patch,
  baseUrl: () => baseUrl,
  requireKey: () => false,
})

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://dsh.local')
  if (url.pathname === '/v1/models') return void handlers.models(request, response)
  if (url.pathname === '/v1/chat/completions') return void handlers.openai(request, response)
  if (url.pathname === '/v1/messages') return void handlers.anthropic(request, response)
  if (url.pathname.startsWith('/kiro-proxy/api')) return void handlers.api(request, response)
  response.writeHead(404).end()
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
baseUrl = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------------------
// 1. /v1/models
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${baseUrl}/v1/models`)
  const body = await response.json()
  check('GET /v1/models 200', response.status === 200, response.status)
  check('模型列表形状', body.object === 'list' && body.data[0].id === 'claude-sonnet-4.5', JSON.stringify(body))
}

// enabledModels 是路由选择，协议面必须与 Harness 选择器看到同一集合。
{
  const filtered = createProxyHandlers({
    client: { ...client, connection: () => ({ enabledModels: ['claude-sonnet-4.5'] }) },
    store,
    keys,
    updateSettings: async patch => patch,
    baseUrl: () => baseUrl,
    requireKey: () => false,
  })
  const filteredServer = createServer((request, response) => void filtered.models(request, response))
  await new Promise(resolve => filteredServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${filteredServer.address().port}/v1/models`
  const body = await fetch(url).then(response => response.json())
  check('enabledModels 过滤 /v1/models', body.data.length === 1 && body.data[0].id === 'claude-sonnet-4.5', JSON.stringify(body.data.map(m => m.id)))
  await new Promise(resolve => filteredServer.close(resolve))
}

// ---------------------------------------------------------------------------
// 2. OpenAI 流式
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4.5',
      stream: true,
      messages: [
        { role: 'system', content: '简洁' },
        { role: 'user', content: '解释一下' },
      ],
    }),
  })
  const text = await response.text()
  const frames = text.split('\n\n').filter(chunk => chunk.trim().length > 0)
  const payloads = frames.map(frame => frame.replace(/^data: /u, ''))
  check('OpenAI SSE content-type', response.headers.get('content-type')?.includes('text/event-stream') === true)
  check('OpenAI 末帧是 [DONE]', payloads.at(-1) === '[DONE]', payloads.at(-1))
  check('OpenAI 首帧带 role', payloads[0].includes('"role":"assistant"'), payloads[0])
  check('OpenAI 文本增量', text.includes('EventStream '), text.slice(0, 200))
  check('OpenAI reasoning_content', text.includes('"reasoning_content"'), text.slice(0, 300))
  check('OpenAI 收尾 finish_reason', text.includes('"finish_reason":"stop"'), text.slice(-300))
  check('OpenAI usage 落末个 chunk', text.includes('"prompt_tokens":11'), text.slice(-300))
}

// ---------------------------------------------------------------------------
// 3. OpenAI 非流式
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: '你好' }] }),
  })
  const body = await response.json()
  check('OpenAI 非流式 200', response.status === 200, response.status)
  check('OpenAI 非流式 object', body.object === 'chat.completion', body.object)
  check('OpenAI 非流式正文', body.choices?.[0]?.message?.content === 'EventStream 与 SSE 不同。', body.choices?.[0]?.message?.content)
  check('OpenAI 非流式 reasoning', body.choices?.[0]?.message?.reasoning_content === '先解释术语。', body.choices?.[0]?.message?.reasoning_content)
  check('OpenAI 非流式 finish_reason', body.choices?.[0]?.finish_reason === 'stop', body.choices?.[0]?.finish_reason)
}

// ---------------------------------------------------------------------------
// 4. Anthropic 流式
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4.5',
      max_tokens: 1024,
      stream: true,
      system: '简洁',
      messages: [{ role: 'user', content: '解释一下' }],
    }),
  })
  const text = await response.text()
  const names = [...text.matchAll(/^event: (.+)$/gmu)].map(match => match[1])
  check('Anthropic SSE content-type', response.headers.get('content-type')?.includes('text/event-stream') === true)
  check('Anthropic message_start 最先', names[0] === 'message_start', names.join(','))
  check('Anthropic message_stop 最后', names.at(-1) === 'message_stop', names.join(','))
  check('Anthropic thinking 块', names.includes('content_block_start') && text.includes('"thinking"'), names.join(','))
  check('Anthropic text_delta', text.includes('"text_delta"'), text.slice(0, 400))
  check('Anthropic stop_reason', text.includes('"stop_reason":"end_turn"'), text.slice(-400))
  check('Anthropic cache usage 字段', text.includes('"input_tokens":11'), text.slice(-400))
}

// ---------------------------------------------------------------------------
// 5. Anthropic 非流式
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4.5',
      max_tokens: 512,
      messages: [{ role: 'user', content: '你好' }],
    }),
  })
  const body = await response.json()
  check('Anthropic 非流式 200', response.status === 200, response.status)
  check('Anthropic 非流式 type', body.type === 'message', body.type)
  check('Anthropic 非流式 content 非空', Array.isArray(body.content) && body.content.length > 0, JSON.stringify(body.content))
  check('Anthropic 非流式 stop_reason', body.stop_reason === 'end_turn', body.stop_reason)
}

// ---------------------------------------------------------------------------
// 6. 状态 API
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${baseUrl}/kiro-proxy/api/status`)
  const body = await response.json()
  check('status 200', response.status === 200, response.status)
  check('status.ok', body.ok === true)
  check('status 模型', body.value?.models?.[0]?.id === 'claude-sonnet-4.5', JSON.stringify(body.value?.models))
  check('status usage', body.value?.usage?.plan === 'KIRO PRO+', JSON.stringify(body.value?.usage))
  check('status 反代地址', body.value?.proxy?.openaiBaseUrl === `${baseUrl}/v1`, body.value?.proxy?.openaiBaseUrl)
  check('status key 已生成', typeof body.value?.proxy?.key === 'string' && body.value.proxy.key.startsWith('kr-'), body.value?.proxy?.key)
  check('status resetAt 单位正确', body.value?.usage?.rows?.[0]?.resetAt === 1793491200000, body.value?.usage?.rows?.[0]?.resetAt)
}

// ---------------------------------------------------------------------------
// 7. 坏请求与未知路由
// ---------------------------------------------------------------------------
{
  const bad = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  check('坏 JSON -> 400', bad.status === 400, bad.status)

  const empty = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [] }),
  })
  check('空 messages -> 400', empty.status === 400, empty.status)

  const unknown = await fetch(`${baseUrl}/kiro-proxy/api/nope`, { method: 'GET' })
  check('未知 API -> 404', unknown.status === 404, unknown.status)
}

// ---------------------------------------------------------------------------
// 8. 密钥门禁
// ---------------------------------------------------------------------------
{
  const guarded = createProxyHandlers({
    client,
    store,
    keys,
    updateSettings: async patch => patch,
    baseUrl: () => baseUrl,
    requireKey: () => true,
  })
  const guardedServer = createServer((request, response) => {
    void guarded.models(request, response)
  })
  await new Promise(resolve => guardedServer.listen(0, '127.0.0.1', resolve))
  const guardedUrl = `http://127.0.0.1:${guardedServer.address().port}`
  const denied = await fetch(`${guardedUrl}/v1/models`)
  check('缺 key -> 401', denied.status === 401, denied.status)
  const key = await keys.get()
  const allowed = await fetch(`${guardedUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  check('带 key -> 200', allowed.status === 200, allowed.status)
  const viaApiKeyHeader = await fetch(`${guardedUrl}/v1/models`, { headers: { 'x-api-key': key } })
  check('x-api-key 也认', viaApiKeyHeader.status === 200, viaApiKeyHeader.status)
  await new Promise(resolve => guardedServer.close(resolve))
}

check('sendWire 收到 contextWindow', lastExtra?.contextWindow === 200000, JSON.stringify(lastExtra))

server.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
