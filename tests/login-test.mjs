/**
 * Builder ID 设备码登录的离线验证：注入 post 与时钟，复刻 OIDC 的三步与各种轮询答复，
 * 断言插件遵守服务端 interval、处理 slow_down / 过期 / 拒绝，且不把秘密泄露给前端。
 * 最后把拿到的凭据存进 AccountStore，确认它能走 OIDC 刷新分支（带内联 clientId/secret）。
 *
 * Run: node tests/login-test.mjs
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { BUILDER_ID_START_URL, DeviceLogin, KIRO_ISSUER_URL, KIRO_SCOPES } from '../lib/kiro-login.js'
import { kiroEndpoint } from '../lib/kiro-client.js'
import { AccountStore, normalizeCredential, resolveAccessToken } from '../lib/kiro-auth.js'

let pass = 0
let fail = 0
const check = (name, condition, detail) => {
  if (condition) { pass += 1; console.log(`PASS  ${name}`); return }
  fail += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
}

/** 一个可脚本化的假 OIDC：按 URL 后缀分派，token 端点按队列答复。 */
function fakeOidc(tokenReplies, overrides = {}) {
  const calls = []
  // 从真实时间起步：存进 store 后 describe() 用的是真实 Date.now()。
  let clock = Date.now()
  const post = async (url, body) => {
    calls.push({ url, body })
    if (url.endsWith('/client/register')) {
      return overrides.register ?? { status: 200, body: { clientId: 'cid-1', clientSecret: 'csecret-1', clientSecretExpiresAt: Math.floor(clock / 1000) + 90 * 86400 } }
    }
    if (url.endsWith('/device_authorization')) {
      return overrides.device ?? { status: 200, body: { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUri: 'https://device.sso.us-east-1.amazonaws.com/', verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH', interval: 5, expiresIn: 600 } }
    }
    if (url.endsWith('/token')) {
      const next = tokenReplies.shift()
      if (next === undefined) throw new Error('token script exhausted')
      return next
    }
    if (url.endsWith('/oauth/device/authorization')) {
      return overrides.socialAuthorize ?? {
        status: 200,
        body: {
          deviceCode: 'sdev-1',
          userCode: 'IJKL-MNOP',
          verificationUriComplete: 'https://app.kiro.dev/account/device?user_code=IJKL-MNOP&login_provider=Google',
          intervalInMilliseconds: 5000,
          expiresInMilliseconds: 300000,
        },
      }
    }
    if (url.endsWith('/oauth/device/poll')) {
      const next = (overrides.socialReplies ?? []).shift()
      if (next === undefined) throw new Error('social script exhausted')
      return next
    }
    throw new Error(`unexpected ${url}`)
  }
  return { calls, post, now: () => clock, advance: ms => { clock += ms } }
}

const pending = { status: 400, body: { error: 'authorization_pending' } }

// 1. 正常路径：start -> 早到的 poll 本地挡回 -> pending -> success
{
  const oidc = fakeOidc([pending, { status: 200, body: { accessToken: 'aoa-new', refreshToken: 'aor-new', expiresIn: 3600 } }])
  const login = new DeviceLogin({ post: oidc.post, now: oidc.now })
  const started = await login.start({ label: 'Mine' })
  check('start 返回 userCode', started.userCode === 'ABCD-EFGH', started.userCode)
  check('start 返回 verificationUriComplete', started.verificationUriComplete.includes('user_code=ABCD-EFGH'))
  check('start 状态为 pending', started.state === 'pending')
  check('view 不含 deviceCode / clientSecret', !JSON.stringify(started).includes('dev-1') && !JSON.stringify(started).includes('csecret-1'))
  const register = oidc.calls.find(call => call.url.endsWith('/client/register'))
  check('注册为 public 客户端并带 CodeWhisperer scopes', register.body.clientType === 'public' && JSON.stringify(register.body.scopes) === JSON.stringify(KIRO_SCOPES))
  check('注册带上 Kiro 的身份中心 issuer', register.body.issuerUrl === KIRO_ISSUER_URL, register.body.issuerUrl)
  check('注册用 Kiro 的客户端名', register.body.clientName === 'kiro-oauth-client', register.body.clientName)
  const device = oidc.calls.find(call => call.url.endsWith('/device_authorization'))
  check('设备授权用 Builder ID startUrl', device.body.startUrl === 'https://view.awsapps.com/start')
  check('OIDC 区域进入 host', device.url === 'https://oidc.us-east-1.amazonaws.com/device_authorization', device.url)

  const early = await login.poll(started.id)
  check('interval 未到时不打 token 端点', early.state === 'pending' && !oidc.calls.some(call => call.url.endsWith('/token')))

  oidc.advance(5_000)
  const waiting = await login.poll(started.id)
  check('authorization_pending 保持 pending', waiting.state === 'pending')
  const tokenCall = oidc.calls.find(call => call.url.endsWith('/token'))
  check('token 请求用 device_code grant', tokenCall.body.grantType === 'urn:ietf:params:oauth:grant-type:device_code' && tokenCall.body.deviceCode === 'dev-1')

  oidc.advance(5_000)
  const done = await login.poll(started.id)
  check('批准后状态为 success', done.state === 'success', done.state)
  check('success 的 view 也不带 token', !JSON.stringify(done).includes('aoa-new'))

  const taken = login.take(started.id)
  check('take 交出凭据', taken?.credential?.accessToken === 'aoa-new' && taken.credential.refreshToken === 'aor-new')
  check('take 带上 label', taken?.label === 'Mine')
  check('凭据带内联 client 注册', taken.credential.clientId === 'cid-1' && taken.credential.clientSecret === 'csecret-1')
  check('take 只交一次', login.take(started.id) === undefined)

  // 存进 store：归一化成 builder-id，且过期后走 OIDC 刷新（而不是报“无法刷新”）
  const directory = await mkdtemp(join(tmpdir(), 'kiro-proxy-login-'))
  const store = new AccountStore(directory)
  const account = await store.save(taken)
  check('存储后 method 为 builder-id', account.method === 'builder-id', account.method)
  check('存储后成为活动账号', (await store.read()).activeId === account.id)
  const described = await store.describe()
  check('describe 状态为 ready', described.accounts[0].state === 'ready', described.accounts[0].state)
  check('describe 不泄露 clientSecret', !JSON.stringify(described).includes('csecret-1'))

  const expired = normalizeCredential({ ...taken.credential, expiresAt: new Date(Date.now() - 3_600_000).toISOString() })
  let code
  try {
    // 指向一个不存在的区域主机名会在网络层失败；关键是它没在本地就判成 INVALID_CREDENTIAL。
    await resolveAccessToken(expired, { region: 'us-east-1', directory, signal: AbortSignal.timeout(1) })
  } catch (error) {
    code = error.code ?? error.name
  }
  check('内联 client 的凭据走 OIDC 刷新分支', code !== 'INVALID_CREDENTIAL', code)
}

// 2. slow_down：interval 加 5 秒
{
  const oidc = fakeOidc([{ status: 400, body: { error: 'slow_down' } }, pending])
  const login = new DeviceLogin({ post: oidc.post, now: oidc.now })
  const started = await login.start()
  oidc.advance(5_000)
  const slowed = await login.poll(started.id)
  check('slow_down 后 interval = 10', slowed.interval === 10, slowed.interval)
  oidc.advance(5_000)
  await login.poll(started.id)
  check('slow_down 后 5 秒内不再请求', oidc.calls.filter(call => call.url.endsWith('/token')).length === 1)
  oidc.advance(5_000)
  await login.poll(started.id)
  check('满 10 秒后才再请求', oidc.calls.filter(call => call.url.endsWith('/token')).length === 2)
}

// 3. AWS __type 形式的错误也能识别
{
  const oidc = fakeOidc([{ status: 400, body: { __type: 'com.amazonaws.ssooidc#AuthorizationPendingException' } }])
  const login = new DeviceLogin({ post: oidc.post, now: oidc.now })
  const started = await login.start()
  oidc.advance(5_000)
  check('__type AuthorizationPendingException -> pending', (await login.poll(started.id)).state === 'pending')
}

// 4. 拒绝 / 过期 / 本地超时 / 取消
{
  const denied = fakeOidc([{ status: 400, body: { error: 'access_denied' } }])
  const a = new DeviceLogin({ post: denied.post, now: denied.now })
  const sa = await a.start()
  denied.advance(5_000)
  const ra = await a.poll(sa.id)
  check('access_denied -> denied 且带错误文字', ra.state === 'denied' && typeof ra.error === 'string', JSON.stringify(ra))

  const expired = fakeOidc([{ status: 400, body: { error: 'expired_token' } }])
  const b = new DeviceLogin({ post: expired.post, now: expired.now })
  const sb = await b.start()
  expired.advance(5_000)
  check('expired_token -> expired', (await b.poll(sb.id)).state === 'expired')

  const late = fakeOidc([])
  const c = new DeviceLogin({ post: late.post, now: late.now })
  const sc = await c.start()
  late.advance(601_000)
  check('超过 expiresIn 本地判 expired 且不发请求', (await c.poll(sc.id)).state === 'expired' && !late.calls.some(call => call.url.endsWith('/token')))

  const cancelled = fakeOidc([])
  const d = new DeviceLogin({ post: cancelled.post, now: cancelled.now })
  const sd = await d.start()
  check('cancel 返回 true', d.cancel(sd.id) === true)
  cancelled.advance(5_000)
  check('取消后 poll 不再请求', (await d.poll(sd.id)).state === 'cancelled' && !cancelled.calls.some(call => call.url.endsWith('/token')))

  let unknownCode
  try { await d.poll('nope') } catch (error) { unknownCode = error.code }
  check('未知 id 抛 INVALID_REQUEST', unknownCode === 'INVALID_REQUEST', unknownCode)
}

// 5. 注册复用与失效
{
  const oidc = fakeOidc([])
  const login = new DeviceLogin({ post: oidc.post, now: oidc.now })
  await login.start()
  await login.start()
  check('同区域只注册一次', oidc.calls.filter(call => call.url.endsWith('/client/register')).length === 1)

  const broken = fakeOidc([], { device: { status: 400, body: { error: 'invalid_client', error_description: 'bad client' } } })
  const other = new DeviceLogin({ post: broken.post, now: broken.now })
  let message
  try { await other.start() } catch (error) { message = error.message }
  check('invalid_client 报出服务端描述', typeof message === 'string' && message.includes('bad client'), message)
  check('invalid_client 后丢弃注册缓存', other.registrations.size === 0)

  let regionCode
  try { await login.start({ region: 'us_east_1' }) } catch (error) { regionCode = error.code }
  check('非法 region 抛 INVALID_CREDENTIAL', regionCode === 'INVALID_CREDENTIAL', regionCode)
}

// 6. IAM 身份中心：自定义 startUrl + 实例区域，产出 idc 凭据
{
  const oidc = fakeOidc([{ status: 200, body: { accessToken: 'aoa-idc', refreshToken: 'aor-idc', expiresIn: 3600 } }])
  const login = new DeviceLogin({ post: oidc.post, now: oidc.now })
  const started = await login.start({ method: 'idc', startUrl: '  https://my-org.awsapps.com/start/  ', region: 'eu-west-1' })
  check('IdC view 的 method 为 idc', started.method === 'idc' && started.region === 'eu-west-1', JSON.stringify(started))
  const register = oidc.calls.find(call => call.url.endsWith('/client/register'))
  check('IdC 在实例区域注册客户端', register.url === 'https://oidc.eu-west-1.amazonaws.com/client/register', register.url)
  check('IdC 注册同样带 issuer', register.body.issuerUrl === KIRO_ISSUER_URL)
  const device = oidc.calls.find(call => call.url.endsWith('/device_authorization'))
  check('IdC 设备授权用规范化后的 startUrl', device.body.startUrl === 'https://my-org.awsapps.com/start', device.body.startUrl)
  oidc.advance(5_000)
  check('IdC 批准后 success', (await login.poll(started.id)).state === 'success')
  const tokenCall = oidc.calls.find(call => call.url.endsWith('/token'))
  check('IdC token 请求打到实例区域', tokenCall.url === 'https://oidc.eu-west-1.amazonaws.com/token', tokenCall.url)
  const taken = login.take(started.id)
  check('IdC 凭据用 Kiro 自己的 IdC 拼写', taken.credential.authMethod === 'IdC' && taken.credential.startUrl === 'https://my-org.awsapps.com/start')

  const directory = await mkdtemp(join(tmpdir(), 'kiro-proxy-idc-'))
  const store = new AccountStore(directory)
  const account = await store.save(taken)
  check('IdC 存储后 method 为 idc', account.method === 'idc', account.method)
  check('IdC 存储后 region 为实例区域', account.region === 'eu-west-1', account.region)
  check('IdC 默认标签', account.label === 'IAM Identity Center · eu-west-1', account.label)
  check('idc 凭据路由到 CodeWhisperer 面', kiroEndpoint('chat', 'eu-west-1', account.method).startsWith('https://codewhisperer.eu-west-1.'))

  // 刷新必须回到注册所在区域，哪怕请求区域被覆盖成别的。
  // 用一个本地代理记录 CONNECT 目标后拒绝，整个过程不出本机。
  const connects = []
  const proxy = createServer()
  proxy.on('connect', (request, socket) => {
    connects.push(request.url)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  const expired = normalizeCredential({ ...taken.credential, expiresAt: new Date(Date.now() - 3_600_000).toISOString() })
  let refreshCode
  try {
    await resolveAccessToken(expired, { region: 'us-east-1', directory, proxyUrl })
  } catch (error) {
    refreshCode = error.code
  }
  await new Promise(resolve => proxy.close(resolve))
  check('IdC 刷新回到实例区域', connects[0] === 'oidc.eu-west-1.amazonaws.com:443', `${connects[0]} / ${refreshCode}`)

  const offline = new DeviceLogin({ post: fakeOidc([]).post })
  let regionCode
  try { await offline.start({ method: 'idc', startUrl: 'https://my-org.awsapps.com/start' }) } catch (error) { regionCode = error.code }
  check('IdC 缺区域时拒绝', regionCode === 'INVALID_REQUEST', regionCode)

  for (const bad of ['http://my-org.awsapps.com/start', 'not a url', 'https://user:pw@my-org.awsapps.com/start', 'https://my-org.awsapps.com/login', 'https://evil.example.com/start']) {
    let code
    try { await offline.start({ method: 'idc', startUrl: bad, region: 'us-east-1' }) } catch (error) { code = error.code }
    check(`非法 startUrl 被拒：${bad}`, code === 'INVALID_REQUEST', code)
  }

  const builder = fakeOidc([])
  const plain = new DeviceLogin({ post: builder.post, now: builder.now })
  const plainStarted = await plain.start({ method: 'builder-id', startUrl: 'https://ignored.awsapps.com/start' })
  check('builder-id 忽略传入的 startUrl', plainStarted.method === 'builder-id')
  const plainDevice = builder.calls.find(call => call.url.endsWith('/device_authorization'))
  check('builder-id 始终用 Builder ID 门户', plainDevice.body.startUrl === BUILDER_ID_START_URL, plainDevice.body.startUrl)
}

// 6b. Google / GitHub：走 Kiro 自己的社交设备码，验证码在 app.kiro.dev 上确认
{
  const oidc = fakeOidc([], {
    socialReplies: [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { accessToken: 'aoa-g', refreshToken: 'aor-g', expiresIn: 3600, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/P' } },
    ],
  })
  const login = new DeviceLogin({ post: oidc.post, now: oidc.now })
  const started = await login.start({ method: 'google' })
  const authorize = oidc.calls.find(call => call.url.endsWith('/oauth/device/authorization'))
  check('社交登录用 Kiro 的 auth 服务', authorize.url === 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization', authorize.url)
  check('社交登录带 kiro-cli 客户端与 provider', authorize.body.clientId === 'kiro-cli' && authorize.body.loginProvider === 'Google')
  check('社交验证码 URL 指向 app.kiro.dev', started.verificationUriComplete.startsWith('https://app.kiro.dev/account/device'), started.verificationUriComplete)
  check('社交 interval 由毫秒折算成秒', started.interval === 5, started.interval)
  oidc.advance(5_000)
  check('社交 pending 保持 pending', (await login.poll(started.id)).state === 'pending')
  oidc.advance(5_000)
  check('社交批准后 success', (await login.poll(started.id)).state === 'success')
  const taken = login.take(started.id)
  check('社交凭据记为 google', taken.credential.authMethod === 'google' && taken.credential.provider === 'Google', JSON.stringify(taken.credential.authMethod))
  check('社交凭据带 profileArn', taken.credential.profileArn === 'arn:aws:codewhisperer:us-east-1:1:profile/P')
  check('社交凭据不带 OIDC client 注册', taken.credential.clientId === undefined)

  const github = new DeviceLogin({ post: fakeOidc([]).post })
  const gh = await github.start({ method: 'github' })
  check('GitHub 登录 provider 为 Github', gh.method === 'github')
}

// 6c. 三种导入：不发网络请求，直接落成 success 并可被 take
{
  const importPost = async () => { throw new Error('import must not call the network') }
  const login = new DeviceLogin({ post: importPost })

  const apiKey = await login.start({ method: 'api-key', secret: 'ksk_live', label: 'K' })
  check('api-key 导入立即 success', apiKey.state === 'success', apiKey.state)
  const apiTaken = login.take(apiKey.id)
  check('api-key 落成 API_KEY 凭据', apiTaken.credential.method === 'api_key' && apiTaken.credential.accessToken === 'ksk_live')

  const refresh = await login.start({ method: 'refresh-token', secret: 'aorAAAA' })
  check('refresh-token 导入立即 success', refresh.state === 'success')
  check('refresh-token 落成 imported 凭据', login.take(refresh.id).credential.method === 'imported')

  const idp = await login.start({ method: 'external-idp', json: JSON.stringify({ refreshToken: 'r', clientId: 'c', tokenEndpoint: 'https://login.microsoftonline.com/x', scope: 's', authMethod: 'external_idp' }) })
  check('external-idp 导入立即 success', idp.state === 'success')
  check('external-idp 保留 external_idp', login.take(idp.id).credential.method === 'external_idp')

  let badCode
  try { await login.start({ method: 'api-key' }) } catch (error) { badCode = error.code }
  check('空 API key 被拒', badCode === 'INVALID_REQUEST', badCode)

  let methodCode
  try { await login.start({ method: 'carrier-pigeon' }) } catch (error) { methodCode = error.code }
  check('未知登录方式被拒', methodCode === 'INVALID_REQUEST', methodCode)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
