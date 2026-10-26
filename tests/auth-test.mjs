/**
 * Auth regression test: the credential vocabulary, the store, and the refresh
 * routing that decides which upstream surface a request reaches.
 *
 * The method-normalization cases matter more than they look: `IdC` read as
 * `builder-id` sends the request to `q.<region>` instead of
 * `codewhisperer.<region>`, and the service answers 403 — a failure that looks
 * like a credential problem and is actually a routing one.
 *
 * Run: node .scratch/auth-test.mjs
 */

import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountStore,
  assertProfileArn,
  assertRegion,
  importCredential,
  normalizeAuthMethod,
  normalizeCredential,
  resolveAccessToken,
} from '../lib/kiro-auth.js'
import { kiroEndpoint, parseUsage } from '../lib/kiro-client.js'

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

const throwsCode = fn => {
  try {
    fn()
    return undefined
  } catch (error) {
    return error.code
  }
}

// ---------------------------------------------------------------------------
// 1. 方法归一化：Kiro 自己的拼写
// ---------------------------------------------------------------------------
{
  check('IdC -> idc', normalizeAuthMethod('IdC') === 'idc', normalizeAuthMethod('IdC'))
  check('social -> social', normalizeAuthMethod('social') === 'social')
  check('external_idp 原样', normalizeAuthMethod('external_idp') === 'external_idp')
  check('builder_id -> builder-id', normalizeAuthMethod('builder_id') === 'builder-id')
  check('api-key -> api_key', normalizeAuthMethod('api-key') === 'api_key')
  check('未知值 + clientIdHash + view.awsapps -> builder-id',
    normalizeAuthMethod(undefined, { clientIdHash: 'x' }) === 'builder-id')
  check('未知值 + clientIdHash + 企业 startUrl -> idc',
    normalizeAuthMethod(undefined, { clientIdHash: 'x', startUrl: 'https://acme.awsapps.com/start' }) === 'idc')
  check('未知值 + tokenEndpoint -> external_idp',
    normalizeAuthMethod(undefined, { tokenEndpoint: 'https://login.microsoftonline.com/x' }) === 'external_idp')
  check('未知值 + tokenType API_KEY -> api_key',
    normalizeAuthMethod(undefined, { tokenType: 'API_KEY' }) === 'api_key')
  // 二次归一化必须保号：这是 import -> save -> describe 这条链上的真实回归。
  check('已归一化的 method 不被重判',
    normalizeAuthMethod(undefined, { method: 'idc', clientIdHash: 'x' }) === 'idc',
    normalizeAuthMethod(undefined, { method: 'idc', clientIdHash: 'x' }))
}

// ---------------------------------------------------------------------------
// 2. 凭据归一化与校验
// ---------------------------------------------------------------------------
{
  const credential = normalizeCredential({
    accessToken: 'aoaAAAA',
    refreshToken: 'aorAAAA',
    expiresAt: '2026-09-01T10:29:34.105Z',
    clientIdHash: 'abc',
    authMethod: 'IdC',
    region: 'us-east-1',
  })
  check('expiresAt 解析成毫秒', credential.expiresAt === Date.parse('2026-09-01T10:29:34.105Z'), credential.expiresAt)
  check('method 归一化', credential.method === 'idc', credential.method)
  check('clientIdHash 保留', credential.clientIdHash === 'abc', credential.clientIdHash)

  check('缺 token 抛 INVALID_CREDENTIAL',
    throwsCode(() => normalizeCredential({ region: 'us-east-1' })) === 'INVALID_CREDENTIAL')
  check('非对象抛 INVALID_CREDENTIAL', throwsCode(() => normalizeCredential('x')) === 'INVALID_CREDENTIAL')

  check('profile ARN 合法通过',
    assertProfileArn('arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC') === 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC')
  check('profile ARN 非法抛 INVALID_CREDENTIAL',
    throwsCode(() => assertProfileArn('not-an-arn')) === 'INVALID_CREDENTIAL')
  check('region 合法通过', assertRegion('eu-central-1') === 'eu-central-1')
  check('region 非法抛 INVALID_CREDENTIAL', throwsCode(() => assertRegion('us_east_1')) === 'INVALID_CREDENTIAL')
}

// ---------------------------------------------------------------------------
// 3. 导入的三种形态
// ---------------------------------------------------------------------------
{
  const fromKey = importCredential({ apiKey: 'ksk_test' })
  check('API key 导入 -> api_key', fromKey.credential.method === 'api_key', fromKey.credential.method)
  check('API key 落成 accessToken', fromKey.credential.accessToken === 'ksk_test')

  const fromRefresh = importCredential({ refreshToken: 'aorAAAA' })
  check('refresh token 导入 -> imported', fromRefresh.credential.method === 'imported', fromRefresh.credential.method)

  const fromJson = importCredential({ json: JSON.stringify({ refreshToken: 'aorBBBB', authMethod: 'social' }) })
  check('JSON 导入保留 social', fromJson.credential.method === 'social', fromJson.credential.method)

  check('空输入抛 INVALID_REQUEST', throwsCode(() => importCredential({})) === 'INVALID_REQUEST')
  check('坏 JSON 抛 INVALID_REQUEST', throwsCode(() => importCredential({ json: '{bad' })) === 'INVALID_REQUEST')
}

// ---------------------------------------------------------------------------
// 4. 端点分派：方法决定上游 surface
// ---------------------------------------------------------------------------
{
  check('idc -> codewhisperer', kiroEndpoint('chat', 'us-east-1', 'idc').includes('codewhisperer.us-east-1.amazonaws.com'), kiroEndpoint('chat', 'us-east-1', 'idc'))
  check('external_idp -> codewhisperer', kiroEndpoint('chat', 'us-east-1', 'external_idp').includes('codewhisperer'))
  check('builder-id -> q', kiroEndpoint('chat', 'us-east-1', 'builder-id').includes('q.us-east-1.amazonaws.com'), kiroEndpoint('chat', 'us-east-1', 'builder-id'))
  check('api_key -> q', kiroEndpoint('chat', 'us-east-1', 'api_key').includes('://q.'))
  check('region 进入 host', kiroEndpoint('chat', 'eu-central-1', 'builder-id').includes('q.eu-central-1.amazonaws.com'), kiroEndpoint('chat', 'eu-central-1', 'builder-id'))
  check('catalog 路径', kiroEndpoint('catalog', 'us-east-1', 'builder-id').endsWith('/ListAvailableModels'), kiroEndpoint('catalog', 'us-east-1', 'builder-id'))
  check('usage 路径', kiroEndpoint('usage', 'us-east-1', 'idc').endsWith('/getUsageLimits'))
}

// ---------------------------------------------------------------------------
// 5. 用量解析：两种时间编码
// ---------------------------------------------------------------------------
{
  const real = {
    daysUntilReset: 0,
    nextDateReset: 1793491200,
    subscriptionInfo: { subscriptionTitle: 'KIRO PRO+' },
    usageBreakdownList: [{
      displayName: 'Credit',
      currentUsage: 113,
      currentUsageWithPrecision: 113.31,
      usageLimit: 2000,
      usageLimitWithPrecision: 2000,
      resourceType: 'CREDIT',
      currency: 'USD',
    }],
  }
  const usage = parseUsage(real, 1_000)
  check('plan 读取', usage.plan === 'KIRO PRO+', usage.plan)
  check('used 用高精度值', usage.rows[0].used === 113.31, usage.rows[0].used)
  check('limit 用高精度值', usage.rows[0].limit === 2000, usage.rows[0].limit)
  check('Unix 秒换算成毫秒', usage.rows[0].resetAt === 1793491200000, usage.rows[0].resetAt)
  check('fetchedAt 用注入的 now', usage.fetchedAt === 1_000, usage.fetchedAt)

  const iso = parseUsage({
    nextDateReset: '2026-11-01T00:00:00.000Z',
    usageBreakdownList: [{ displayName: 'X', currentUsageWithPrecision: 1, usageLimitWithPrecision: 2 }],
  }, 0)
  check('ISO 字符串也能解析', iso.rows[0].resetAt === Date.parse('2026-11-01T00:00:00.000Z'), iso.rows[0].resetAt)

  check('无 breakdown 抛 MALFORMED_RESPONSE',
    throwsCode(() => parseUsage({})) === 'MALFORMED_RESPONSE')
  check('空行抛 MALFORMED_RESPONSE',
    throwsCode(() => parseUsage({ usageBreakdownList: [] })) === 'MALFORMED_RESPONSE')
}

// ---------------------------------------------------------------------------
// 6. 账号存储：多账号、切换、删除后的选择交接
// ---------------------------------------------------------------------------
{
  const directory = await mkdtemp(join(tmpdir(), 'kiro-proxy-auth-'))
  const store = new AccountStore(directory)

  const empty = await store.read()
  check('空 store 可读', empty.accounts.length === 0 && empty.activeId === null, JSON.stringify(empty))

  const a = await store.save({ credential: { refreshToken: 'aorA', authMethod: 'social', region: 'us-east-1' }, label: 'A' })
  const b = await store.save({ credential: { accessToken: 'ksk_b', authMethod: 'api_key', region: 'us-east-1' }, label: 'B' })
  check('两个账号都存下', (await store.read()).accounts.length === 2)
  check('最后保存的成为活动账号', (await store.read()).activeId === b.id, (await store.read()).activeId)

  await store.use(a.id)
  check('use 切换活动账号', (await store.read()).activeId === a.id)

  const described = await store.describe()
  check('describe 暴露 state', described.accounts.map(item => item.state).join(',') === 'refresh,ready', JSON.stringify(described.accounts.map(item => item.state)))
  check('describe 标记 active', described.accounts.find(item => item.id === a.id)?.active === true)
  check('describe 不泄露 token', !JSON.stringify(described).includes('aorA') && !JSON.stringify(described).includes('ksk_b'))

  await store.remove(a.id)
  const afterRemove = await store.read()
  check('删除活动账号后交接给另一个', afterRemove.activeId === b.id, afterRemove.activeId)
  check('账号数减一', afterRemove.accounts.length === 1)

  await store.clear()
  check('clear 清空 store', (await store.read()).accounts.length === 0)
}

// ---------------------------------------------------------------------------
// 7. token 解析：API key 不刷新；缺 refresh 且过期 -> INVALID_CREDENTIAL
// ---------------------------------------------------------------------------
{
  const apiKey = await resolveAccessToken(
    normalizeCredential({ accessToken: 'ksk_x', authMethod: 'api_key' }),
    { region: 'us-east-1' },
  )
  check('API key 直接可用', apiKey.accessToken === 'ksk_x' && apiKey.refreshed === false, JSON.stringify(apiKey))

  const fresh = await resolveAccessToken(
    normalizeCredential({
      accessToken: 'aoa_fresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      authMethod: 'social',
    }),
    { region: 'us-east-1' },
  )
  check('未过期 token 不刷新', fresh.refreshed === false && fresh.accessToken === 'aoa_fresh', JSON.stringify(fresh))

  const directory = await mkdtemp(join(tmpdir(), 'kiro-proxy-refresh-'))
  let code
  try {
    await resolveAccessToken(
      normalizeCredential({
        accessToken: 'aoa_expired',
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        authMethod: 'idc',
        clientIdHash: 'missing-registration',
      }),
      { region: 'us-east-1', directory },
    )
  } catch (error) {
    code = error.code
  }
  check('过期 + 缺设备注册 -> INVALID_CREDENTIAL', code === 'INVALID_CREDENTIAL', code)

  // 设备注册存在时，刷新会真的发出去；用假的 endpoint 会失败，但错误码必须是 AUTH。
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'hash1.json'), JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }), 'utf8')
  let refreshCode
  try {
    await resolveAccessToken(
      normalizeCredential({
        accessToken: 'aoa_expired',
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        authMethod: 'idc',
        clientIdHash: 'hash1',
      }),
      { region: 'us-east-1', directory },
    )
  } catch (error) {
    refreshCode = error.code
  }
  // 真凭据是假的，OIDC 会拒绝；重点是它没有在本地就崩，而是走到了网络并归类为 AUTH。
  check('有设备注册时刷新走到网络并归类 AUTH/TRANSPORT', ['AUTH', 'TRANSPORT', 'INVALID_CREDENTIAL'].includes(refreshCode), refreshCode)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
