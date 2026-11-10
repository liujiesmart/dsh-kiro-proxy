/**
 * End-to-end live check against the upgraded Kiro (1.4.121).
 *
 * The offline suites stub the transport, so they cannot notice that the real
 * service moved hosts. This one uses the real credential and the real network,
 * and exercises the three surfaces a caller actually touches:
 *
 *   1. the Harness adapter (`listModels` / `prepareCall` / `stream`), including a
 *      tool call, since tool frames are the most shape-sensitive part,
 *   2. the OpenAI-compatible reverse proxy (`/v1/models`, `/v1/chat/completions`),
 *   3. the Anthropic-compatible reverse proxy (`/v1/messages`).
 *
 * This needs a real credential and the network, so it is deliberately NOT part
 * of the offline `run-all` suite; run it by hand after an upgrade:
 *
 *   node tests/live-1.4.121.mjs
 *
 * It exits 1 on any failure, so it can gate a release.
 */
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KiroProxyAdapter } from '../lib/adapter.js'
import { AccountStore } from '../lib/kiro-auth.js'
import { KiroClient } from '../lib/kiro-client.js'
import { ProxyKeyStore, createProxyHandlers } from '../lib/web.js'

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
    return
  }
  fail += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const directory = await mkdtemp(join(tmpdir(), 'kiro-live-'))
const store = new AccountStore(directory)
const keys = new ProxyKeyStore(directory)
let settings = {}
const client = new KiroClient({ store, options: () => settings })

// --- 1. adapter ------------------------------------------------------------
const adapter = new KiroProxyAdapter({ store, client, options: () => settings })
const provider = { id: 'kiro-proxy', name: 'Kiro', options: {} }

const catalog = await adapter.listModels(provider)
check('adapter listModels 返回目录', Array.isArray(catalog) && catalog.length > 0, catalog?.length)
check('目录里至少一个模型声明图片能力', catalog.some(m => (m.inputModalities ?? []).includes('image')))
const sonnet = catalog.find(m => String(m.id).includes('sonnet')) ?? catalog[0]
check('选中一个模型用于对话', sonnet !== undefined, sonnet?.id)

// Plain text turn.
const textEvents = []
for await (const event of adapter.stream({
  provider,
  model: sonnet.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
  system: 'You are terse.',
  tools: [],
})) textEvents.push(event)

const textDelta = textEvents.filter(e => e.type === 'text-delta').map(e => e.delta ?? e.text).join('')
check('adapter 文本轮拿到正文', textDelta.includes('PONG'), JSON.stringify(textDelta).slice(0, 120))
check('adapter 文本轮有 finish', textEvents.some(e => e.type === 'finish' || e.type === 'done'), [...new Set(textEvents.map(e => e.type))].join(','))
check('adapter 文本轮报 usage', textEvents.some(e => e.type === 'usage'), [...new Set(textEvents.map(e => e.type))].join(','))

// Tool turn: the most shape-sensitive path (`toolUseEvent` frames).
const toolEvents = []
for await (const event of adapter.stream({
  provider,
  model: sonnet.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the ping tool with value "yes". Do not answer in prose.' }] }],
  tools: [{
    name: 'ping',
    description: 'Echo a value back.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  }],
})) toolEvents.push(event)

const toolDelta = toolEvents.filter(e => e.type === 'tool-call-delta')
check('adapter 工具轮发出工具块', toolDelta.length > 0, [...new Set(toolEvents.map(e => e.type))].join(','))
const toolName = toolDelta.map(e => e.toolName ?? e.name).find(Boolean)
check('工具名回成 harness 侧名字', toolName === 'ping', toolName)

// --- 2 & 3. reverse proxy surfaces ----------------------------------------
let baseUrl = ''
const handlers = createProxyHandlers({
  client,
  store,
  keys,
  updateSettings: async patch => { settings = { ...settings, ...patch }; return settings },
  baseUrl: () => baseUrl,
  requireKey: () => false,
})

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://dsh.local')
  if (url.pathname === '/v1/models') return void handlers.models(request, response)
  if (url.pathname === '/v1/chat/completions') return void handlers.openai(request, response)
  if (url.pathname === '/v1/messages') return void handlers.anthropic(request, response)
  response.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
baseUrl = `http://127.0.0.1:${server.address().port}`

const models = await fetch(`${baseUrl}/v1/models`).then(r => r.json())
check('/v1/models 有 data 数组', Array.isArray(models?.data) && models.data.length > 0, JSON.stringify(models).slice(0, 120))
check('/v1/models 带 inputModalities', (models?.data ?? []).some(m => Array.isArray(m.inputModalities) && m.inputModalities.includes('image')))

const openai = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: sonnet.id,
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    stream: false,
  }),
}).then(async r => ({ status: r.status, body: await r.json() }))
const openaiText = openai.body?.choices?.[0]?.message?.content ?? ''
check('OpenAI 反代返回 200', openai.status === 200, JSON.stringify(openai.body).slice(0, 160))
check('OpenAI 反代拿到正文', openaiText.includes('PONG'), JSON.stringify(openaiText).slice(0, 120))

const anthropic = await fetch(`${baseUrl}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({
    model: sonnet.id,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
  }),
}).then(async r => ({ status: r.status, body: await r.json() }))
const anthropicText = (anthropic.body?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
check('Anthropic 反代返回 200', anthropic.status === 200, JSON.stringify(anthropic.body).slice(0, 160))
check('Anthropic 反代拿到正文', anthropicText.includes('PONG'), JSON.stringify(anthropicText).slice(0, 120))

server.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
