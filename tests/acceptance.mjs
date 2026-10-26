/**
 * 安装后的验收：证明插件在真实 Host 里活着，而不是只装上了。
 *
 * 分三层：
 *  1. Host 半：adapter 注册进 llm、反代路由挂上 webServer（走 cordis inspect 的 Config 目录）。
 *  2. HTTP 半：真实 GUI 端口上的 /v1/* 与 /kiro-proxy/api/*。
 *  3. Client 半：从 /plugins/??<id>/client.js&rev=<rev> 取到服务端真正在发的那份 bundle，
 *     确认它就是 client.js 的字节（而不是缓存里的旧世代）。
 *
 * Run: node .scratch/acceptance.mjs
 */

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

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

const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:53984'

/** 复刻 Host 的 artifactRevision：mtime/ctime/size 的定界 sha1 前 12 位。 */
function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// 1. Host 半：状态 API 就是 Host 活着的证据
// ---------------------------------------------------------------------------
let status
{
  const response = await fetch(`${base}/kiro-proxy/api/status`)
  check('状态 API 200', response.status === 200, response.status)
  const body = await response.json()
  status = body.value
  check('状态 ok', body.ok === true, body.ok)
  check('凭据来源是 kiro-cache 或 managed', ['kiro-cache', 'managed'].includes(status?.credentialSource), status?.credentialSource)
  check('发现到模型', Array.isArray(status?.models) && status.models.length > 0, status?.models?.length)
  check('模型带上下文窗口', status?.models?.some(model => Number.isInteger(model.contextWindow)), JSON.stringify(status?.models?.[0]))
  check('读到额度', typeof status?.usage?.plan === 'string' && status.usage.plan.length > 0, status?.usage?.plan)
  check('额度行有 used/limit', Number.isFinite(status?.usage?.rows?.[0]?.used) && Number.isFinite(status?.usage?.rows?.[0]?.limit), JSON.stringify(status?.usage?.rows?.[0]))
  check('重置时间是未来（秒->毫秒换算正确）', (status?.usage?.rows?.[0]?.resetAt ?? 0) > Date.now(), status?.usage?.rows?.[0]?.resetAt)
  check('反代地址指向本端口', status?.proxy?.openaiBaseUrl === `${base}/v1`, status?.proxy?.openaiBaseUrl)
  check('反代 key 已生成', typeof status?.proxy?.key === 'string' && status.proxy.key.startsWith('kr-'), status?.proxy?.key?.slice(0, 6))
  check('无错误', Array.isArray(status?.errors) && status.errors.length === 0, JSON.stringify(status?.errors))
}

// ---------------------------------------------------------------------------
// 2. HTTP 半：两个协议面
// ---------------------------------------------------------------------------
{
  const models = await fetch(`${base}/v1/models`).then(response => response.json())
  check('/v1/models 是 OpenAI 形状', models.object === 'list' && Array.isArray(models.data), JSON.stringify(models).slice(0, 120))
  // /v1/models 受「启用模型」勾选影响，status.models 始终是完整目录，
  // 所以数量只在没有勾选约束时才相等。
  const enabled = Array.isArray(status.enabledModels) ? status.enabledModels : []
  const expected = enabled.length === 0 ? status.models.length : enabled.length
  check('/v1/models 与启用集合一致', models.data.length === expected, `${models.data.length} vs ${expected}（enabled=${enabled.length}）`)
}
{
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
    }),
  })
  const body = await response.json()
  check('OpenAI 非流式 200', response.status === 200, response.status)
  check('OpenAI 有正文', typeof body.choices?.[0]?.message?.content === 'string' && body.choices[0].message.content.length > 0, JSON.stringify(body.choices?.[0]?.message)?.slice(0, 160))
  check('OpenAI finish_reason', body.choices?.[0]?.finish_reason === 'stop', body.choices?.[0]?.finish_reason)
  check('OpenAI usage 非零输入', (body.usage?.prompt_tokens ?? 0) > 0, JSON.stringify(body.usage))
  check('OpenAI usage 非零输出', (body.usage?.completion_tokens ?? 0) > 0, JSON.stringify(body.usage))
}
{
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4.5',
      max_tokens: 128,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
    }),
  })
  const body = await response.json()
  check('Anthropic 非流式 200', response.status === 200, response.status)
  check('Anthropic type=message', body.type === 'message', body.type)
  check('Anthropic content 非空', Array.isArray(body.content) && body.content.length > 0, JSON.stringify(body.content)?.slice(0, 160))
  check('Anthropic stop_reason', ['end_turn', 'tool_use', 'max_tokens'].includes(body.stop_reason), body.stop_reason)
}
{
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4.5',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
    }),
  })
  const text = await response.text()
  const events = [...text.matchAll(/^event: (.+)$/gmu)].map(match => match[1])
  check('Anthropic 流式首帧 message_start', events[0] === 'message_start', events[0])
  check('Anthropic 流式末帧 message_stop', events.at(-1) === 'message_stop', events.at(-1))
  check('Anthropic 流式无 error 帧', !events.includes('error'), events.filter(name => name === 'error').length)
  check('Anthropic 流式有 text_delta', text.includes('"text_delta"'), text.slice(0, 200))
}

// ---------------------------------------------------------------------------
// 3. Client 半：服务端在发的那份 bundle 就是本地的 client.js
// ---------------------------------------------------------------------------
{
  const path = new URL('../client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
  const local = readFileSync(path)
  const stat = statSync(path)
  const rev = framedHash('plugin-artifact', [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)])
  const response = await fetch(`${base}/plugins/??dsh-kiro-proxy/client.js&rev=${rev}`)
  check('client bundle 路由 200', response.status === 200, response.status)
  const served = await response.text()
  // The Host appends `;\n//# sourceMappingURL=…` when it serves a plugin bundle,
  // so "the same bytes" means the same source text plus that one trailer — not a
  // byte-for-byte copy.
  const trailer = /;\n\/\/# sourceMappingURL=\?\?dsh-kiro-proxy\/client\.js\.map&rev=[0-9a-f]+\n?$/u
  const body = served.replace(trailer, '')
  check('bundle 内容与本地 client.js 一致（去掉 sourceMappingURL 尾巴）', body === local.toString('utf8'), `${body.length} vs ${local.length}`)
  check('bundle 带 sourceMappingURL', trailer.test(served), served.slice(-120))
  check('bundle 注册 settings.section', served.includes("'settings.section'"))
  check('bundle 注册 conversation.input.right', served.includes("'conversation.input.right'"))
  check('bundle 声明 inject slots+locale', served.includes("inject: ['slots', 'locale']"))
  check('bundle 有 locale 命名空间', served.includes('dsh-kiro-proxy'))
  check('bundle 走状态 API', served.includes('/kiro-proxy/api/status'))
}

// ---------------------------------------------------------------------------
// 4. 反代 key 门禁：默认关闭，但 key 必须可用（打开后能立刻生效）
// ---------------------------------------------------------------------------
{
  const response = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${status.proxy.key}` },
  })
  check('带 key 请求也 200', response.status === 200, response.status)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
