/**
 * 节流与重试的离线验证：用注入的 post/sleep 复刻「Encountered unexpectedly high
 * load」的三种到达方式，断言插件自己就把它们吃掉了，且绝不重复已经吐出去的内容。
 *
 * Run: node .scratch/retry-test.mjs
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

const OVERLOAD = 'Encountered unexpectedly high load when processing the request, please try again.'

/** 构造一帧 eventstream 记录。 */
function frame(headers, payload) {
  const nameBytes = Object.entries(headers).map(([name, value]) => {
    const nameBuf = Buffer.from(name, 'utf8')
    const valueBuf = Buffer.from(value, 'utf8')
    return Buffer.concat([
      Buffer.from([nameBuf.length]), nameBuf, Buffer.from([7]),
      Buffer.from([(valueBuf.length >> 8) & 0xff, valueBuf.length & 0xff]), valueBuf,
    ])
  })
  const headerBuf = Buffer.concat(nameBytes)
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8')
  const total = 12 + headerBuf.length + payloadBuf.length + 4
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(total, 0)
  prelude.writeUInt32BE(headerBuf.length, 4)
  return Buffer.concat([prelude, headerBuf, payloadBuf, Buffer.alloc(4)])
}

function streamOf(frames) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of frames) yield chunk
    },
  }
}

const okFrames = [
  frame({ ':event-type': 'assistantResponseEvent' }, { content: '你好' }),
  frame({ ':event-type': 'metadataEvent' }, { stopReason: 'END_TURN' }),
]
const overloadFrames = [
  frame({ ':exception-type': 'throttlingException' }, { message: OVERLOAD }),
]

const baseCredential = {
  accessToken: 'ksk_test',
  authMethod: 'api_key',
  region: 'us-east-1',
}

/** 每次 build 一个 client：post 按脚本返回，sleep 只记录不真的等。 */
function buildClient(script, options = {}) {
  const calls = { post: [], sleep: [] }
  const client = new KiroClient({
    options: () => ({ ...baseCredential, ...options }),
    store: {
      directory: 'unused',
      active: async () => ({ credential: { accessToken: 'ksk_test', method: 'api_key', region: 'us-east-1' }, id: 'a', label: 'A' }),
      read: async () => ({ accounts: [], activeId: null }),
      describe: async () => ({ activeId: null, accounts: [] }),
      clear: async () => {},
    },
    post: async spec => {
      calls.post.push(spec)
      const next = script.shift()
      if (next === undefined) throw new Error('script exhausted')
      if (next instanceof Error) throw next
      return next
    },
    sleep: async ms => { calls.sleep.push(ms) },
  })
  return { client, calls }
}

async function drain(client) {
  const events = []
  for await (const event of client.sendWire({ conversationState: {} }, new AbortController().signal)) {
    events.push(event)
  }
  return events
}

const body = () => ({
  status: 200,
  headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  body: streamOf(okFrames),
})

// ---------------------------------------------------------------------------
// 1. HTTP 200 + 流内 throttlingException（就是用户遇到的那条）-> 自动重试成功
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
    body(),
  ])
  const events = await drain(client)
  const text = events.filter(event => event.kind === 'text').map(event => event.text).join('')
  check('流内节流被内部重试吃掉', text === '你好', text)
  check('重试次数正确（2 次 POST：换面即可，不必退避）', calls.post.length === 2, calls.post.length)
  check('换面救回时不需要退避', calls.sleep.length === 0, JSON.stringify(calls.sleep))
  check('第二次打的是另一个 surface', calls.post[0].url !== calls.post[1].url, `${calls.post[0].url} vs ${calls.post[1].url}`)
  check('调用 id 每次不同', calls.post[0].headers['Amz-Sdk-Invocation-Id'] !== calls.post[1].headers['Amz-Sdk-Invocation-Id'])
}

// ---------------------------------------------------------------------------
// 2. 一个面 429 -> 立刻换另一个面（不等，换面比退避快）
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([
    { status: 429, headers: {}, body: streamOf([]) },
    body(),
  ])
  const events = await drain(client)
  check('单面 429 被换面救回', events.some(event => event.kind === 'text'), JSON.stringify(events))
  check('换面不需要退避', calls.sleep.length === 0, JSON.stringify(calls.sleep))
  check('换面打的是另一个 surface',
    calls.post[0].url !== calls.post[1].url,
    `${calls.post[0].url} vs ${calls.post[1].url}`)
  check('记住可用的 surface（第二次请求直接命中）', client.surfacePreference.size === 1, client.surfacePreference.size)
}

// ---------------------------------------------------------------------------
// 2b. 两个面都 429 -> 才按 retry-after 退避
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([
    { status: 429, headers: { 'x-amzn-kiro-ratelimit-retry-after': '2' }, body: streamOf([]) },
    { status: 429, headers: {}, body: streamOf([]) },
    body(),
  ])
  const events = await drain(client)
  check('两个面都 429 后仍能救回', events.some(event => event.kind === 'text'), JSON.stringify(events))
  check('按 retry-after=2s 等待', calls.sleep[0] === 2000, JSON.stringify(calls.sleep))
}

// ---------------------------------------------------------------------------
// 3. 一直节流（每轮两个面都过载）-> 抛出可路由的 RATE_LIMIT
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
    { status: 200, headers: {}, body: streamOf(overloadFrames) },
  ])
  let error
  try {
    await drain(client)
  } catch (cause) {
    error = cause
  }
  check('三次都节流后抛出', error !== undefined)
  check('错误码是 RATE_LIMIT 或 SERVER', ['RATE_LIMIT', 'SERVER'].includes(error?.code), error?.code)
  check('错误信息保留原文', String(error?.message).includes('high load'), error?.message)
  check('重试次数用满（3 轮 × 2 面 = 6 次出站）', calls.post.length === 6, calls.post.length)
}

// ---------------------------------------------------------------------------
// 4. 已经开始输出后再节流 -> 绝不重发（否则前台会看到重复内容）
// ---------------------------------------------------------------------------
{
  const partial = [
    frame({ ':event-type': 'assistantResponseEvent' }, { content: '前半段' }),
    frame({ ':exception-type': 'throttlingException' }, { message: OVERLOAD }),
  ]
  const { client, calls } = buildClient([{ status: 200, headers: {}, body: streamOf(partial) }, body()])
  const emitted = []
  let error
  try {
    for await (const event of client.sendWire({ conversationState: {} }, new AbortController().signal)) emitted.push(event)
  } catch (cause) {
    error = cause
  }
  check('已输出后不重试', calls.post.length === 1, calls.post.length)
  check('已输出的内容只出现一次', emitted.filter(event => event.kind === 'text').length === 1)
  check('中途失败仍上报', error !== undefined, error?.message)
}

// ---------------------------------------------------------------------------
// 5. 不可重试的 400 -> 只发一次
// ---------------------------------------------------------------------------
{
  const { client, calls } = buildClient([{ status: 400, headers: {}, body: streamOf([]) }])
  let error
  try {
    await drain(client)
  } catch (cause) {
    error = cause
  }
  check('400 不重试', calls.post.length === 1, calls.post.length)
  check('400 归类 INVALID_REQUEST', error?.code === 'INVALID_REQUEST', error?.code)
}

// ---------------------------------------------------------------------------
// 6. 并发闸门：maxConcurrency=1 时两条请求串行
// ---------------------------------------------------------------------------
{
  let active = 0
  let peak = 0
  const { client } = buildClient([], { maxConcurrency: 1 })
  client.post = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 15))
    active -= 1
    return { status: 200, headers: {}, body: streamOf(okFrames) }
  }
  await Promise.all([drain(client), drain(client)])
  check('maxConcurrency=1 时没有并发出站', peak === 1, peak)
}

// ---------------------------------------------------------------------------
// 7. IdC：凭据没有 profileArn、实例区域 eu-west-1 -> 自动发现 ARN，
//    聊天请求打到 ARN 所在区域，并带上 ARN（不带会 403 AccessDenied）
// ---------------------------------------------------------------------------
{
  const idcStore = {
    directory: 'unused',
    active: async () => ({
      credential: { accessToken: 'aoa-idc', method: 'idc', region: 'eu-west-1', expiresAt: Date.now() + 3_600_000 },
      id: 'idc',
      label: 'IdC',
    }),
    read: async () => ({ accounts: [], activeId: null }),
    describe: async () => ({ activeId: null, accounts: [] }),
    clear: async () => {},
  }
  const arn = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF'
  const lookups = []
  const posts = []
  const client = new KiroClient({
    options: () => ({}),
    store: idcStore,
    postJson: async (url, payload, headers) => {
      lookups.push({ url, headers })
      // 只有 us-east-1 的 CodeWhisperer 面有这个账号的 profile
      if (url === 'https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles') {
        return { status: 200, body: { profiles: [{ arn, profileName: 'Kiro' }] } }
      }
      return { status: 403, body: { message: 'not here' } }
    },
    post: async spec => { posts.push(spec); return { status: 200, headers: {}, body: streamOf(okFrames) } },
    sleep: async () => {},
  })
  const events = await drain(client)
  check('IdC 请求成功', events.some(event => event.kind === 'text'), JSON.stringify(events))
  check('IdC 先问实例区域的 CodeWhisperer 面', lookups[0]?.url === 'https://codewhisperer.eu-west-1.amazonaws.com/ListAvailableProfiles', lookups[0]?.url)
  check('profile 查询不带 profile-arn 头', lookups.every(item => item.headers['x-amzn-codewhisperer-profile-arn'] === undefined))
  check('IdC 聊天打到 ARN 所在区域', posts[0]?.url === 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse', posts[0]?.url)
  check('IdC 聊天带 profile-arn 头', posts[0]?.headers['x-amzn-codewhisperer-profile-arn'] === arn)
  const sent = JSON.parse(posts[0]?.body ?? '{}')
  check('IdC 请求体带 profileArn', sent.profileArn === arn, sent.profileArn)

  // 第二次请求命中缓存，不再查询
  const before = lookups.length
  await drain(client)
  check('profileArn 被缓存', lookups.length === before, `${before} -> ${lookups.length}`)
}

// ---------------------------------------------------------------------------
// 8. IdC 发现失败 -> 仍发请求（交给上游报错），且失败结果短暂缓存
// ---------------------------------------------------------------------------
{
  let lookups = 0
  const posts = []
  const client = new KiroClient({
    options: () => ({}),
    store: {
      directory: 'unused',
      active: async () => ({ credential: { accessToken: 'aoa-x', method: 'idc', region: 'us-east-1', expiresAt: Date.now() + 3_600_000 }, id: 'x', label: 'X' }),
      read: async () => ({ accounts: [], activeId: null }),
      describe: async () => ({ activeId: null, accounts: [] }),
      clear: async () => {},
    },
    postJson: async () => { lookups += 1; return { status: 403, body: {} } },
    post: async spec => { posts.push(spec); return { status: 200, headers: {}, body: streamOf(okFrames) } },
    sleep: async () => {},
  })
  await drain(client)
  const first = lookups
  await drain(client)
  check('发现失败时仍发聊天请求', posts.length === 2, posts.length)
  check('发现失败被短暂缓存', lookups === first, `${first} -> ${lookups}`)
  check('无 ARN 时不带 profile-arn 头', posts[0].headers['x-amzn-codewhisperer-profile-arn'] === undefined)
}

// ---------------------------------------------------------------------------
// 9. 面板调用 models(undefined) / usage(undefined)：IdC 发现路径不能读 undefined.aborted
// ---------------------------------------------------------------------------
{
  const client = new KiroClient({
    options: () => ({}),
    store: {
      directory: 'unused',
      active: async () => ({ credential: { accessToken: 'aoa-y', method: 'idc', region: 'eu-west-1', expiresAt: Date.now() + 3_600_000 }, id: 'y', label: 'Y' }),
      read: async () => ({ accounts: [], activeId: null }),
      describe: async () => ({ activeId: null, accounts: [] }),
      clear: async () => {},
    },
    // 网络错误走 catch 分支，正是那里读了 signal.aborted
    postJson: async () => { throw new Error('ECONNRESET') },
    post: async () => ({ status: 200, headers: {}, body: streamOf(okFrames) }),
    sleep: async () => {},
  })
  for (const name of ['models', 'usage']) {
    let message = ''
    try {
      await client[name](undefined, false)
    } catch (error) {
      message = String(error?.message)
    }
    check(`${name}(undefined) 不因 signal 缺失崩溃`, !message.includes("reading 'aborted'"), message)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
