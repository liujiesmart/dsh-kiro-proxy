/**
 * client.js 的离线渲染自测。
 *
 * 目的：在没有浏览器、没有真 React 的情况下，证明三件事：
 * 1. `window.__ModuleLoader__.load` 被调用一次，factory 能执行并返回 `{ inject, apply }`；
 * 2. `apply(fakeCtx)` 对 `slots.inject` 的两次调用参数完全符合契约（槽名/id/order/label/locale）；
 * 3. `locale.register(NS, { en, zh })` 被调用，两份字典都非空且键集合一致。
 *
 * 额外做一层“假渲染”：用一个极小但带状态的 hooks 实现真正执行组件函数体，
 * 并让 `setState` 触发重渲染，这样异步 `fetch` 回来的 status 也能进树，
 * 账号行/用量行/徽标百分比这些分支才真的被跑到。
 * 仍然不覆盖：真实浏览器的布局、真实 React 的并发与依赖比较语义、真实 Host 的 API 返回。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const clientPath = join(root, 'client.js')
const logPath = join(here, 'ui-render-test.log')

const lines = []
const failures = []
function log(line) {
  lines.push(line)
  console.log(line)
}
function check(name, condition, detail) {
  if (condition) log(`PASS  ${name}`)
  else {
    log(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(name)
  }
}

// ── 假 React：带 hook 帧的最小渲染器 ────────────────────────────────────────
// 每个组件实例（按遍历路径区分）持有一份 hook 数组；setState 直接改数组并置脏，
// 由 settle() 负责重渲染 —— 这足以复现“fetch 回来后 UI 更新”的行为。
const frames = new Map()
let currentFrame
let dirty = false
let activeRoot

function createElement(type, props, ...children) {
  return {
    type,
    props: props || {},
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
  }
}

function hookSlot() {
  const frame = currentFrame
  const index = frame.cursor
  frame.cursor += 1
  return { frame, index }
}

const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement,
  useState(initial) {
    const { frame, index } = hookSlot()
    if (!(index in frame.hooks)) {
      frame.hooks[index] = typeof initial === 'function' ? initial() : initial
    }
    return [frame.hooks[index], (next) => {
      const value = typeof next === 'function' ? next(frame.hooks[index]) : next
      if (Object.is(value, frame.hooks[index])) return
      frame.hooks[index] = value
      dirty = true
    }]
  },
  useRef(initial) {
    const { frame, index } = hookSlot()
    if (!(index in frame.hooks)) frame.hooks[index] = { current: initial }
    return frame.hooks[index]
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  useEffect(fn) {
    const { frame, index } = hookSlot()
    // 只在“挂载”时跑一次：依赖比较不在本测试范围内，
    // 而 effect 里都是 fetch / interval，重复跑只会让断言更嘈杂。
    if (!(index in frame.hooks)) {
      frame.hooks[index] = fn() ?? null
    }
    return undefined
  },
}

function renderComponent(Component, props, path) {
  let frame = frames.get(path)
  if (frame === undefined) {
    frame = { hooks: [], cursor: 0 }
    frames.set(path, frame)
  }
  frame.cursor = 0
  const previous = currentFrame
  currentFrame = frame
  try {
    return Component(props)
  } finally {
    currentFrame = previous
  }
}

/** 遍历渲染树；函数组件走 renderComponent，得到它真正的输出。 */
function walk(node, visit, path = 'root') {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, visit, `${path}[${index}]`))
    return
  }
  if (typeof node === 'string' || typeof node === 'number') { visit(node, undefined); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(renderComponent(node.type, node.props, `${path}<${node.type.name || 'anon'}>`), visit, `${path}<${node.type.name || 'anon'}>`)
    return
  }
  visit(node, node.type)
  node.children.forEach((child, index) => walk(child, visit, `${path}.${index}`))
}

/** 把渲染树摊平成 class / 文本，同时强制递归渲染函数组件。 */
function collect(tree, rootPath) {
  const classes = []
  const texts = []
  const elements = []
  // 路径必须从调用方传进来：hook 帧是按路径区分的，
  // 如果这里固定用 'root'，第二个用例会复用第一个用例已完成的 state。
  walk(tree, (value) => {
    if (typeof value === 'string' || typeof value === 'number') { texts.push(String(value)); return }
    elements.push(value)
    if (value && value.props && typeof value.props.className === 'string') classes.push(value.props.className)
  }, rootPath)
  return { classes, texts, elements, blob: texts.join(' | ') }
}

/**
 * 渲染 + 等异步 setState 落定 + 重渲染，直到没有新的脏标记。
 *
 * 关键点：宿主的槽组件是 `() => h(RealComponent, props)` 的箭头函数，
 * 真正的组件在树里面，所以每轮必须完整 walk 一次才会执行到它 ——
 * 只调根组件是拿不到任何 hook 的。
 */
async function settleAt(Component, props, rootPath) {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  let result
  for (let round = 0; round < 12; round += 1) {
    dirty = false
    const tree = renderComponent(Component, props, rootPath)
    const collected = collect(tree, rootPath)
    await tick()
    await tick()
    result = { tree, ...collected }
    if (!dirty) break
  }
  activeRoot = result.tree
  return result
}

/** 每次调用都用新的路径 = 全新的 hook 帧，等价于“重新挂载”。 */
let mountIndex = 0
function settleFresh(Component, props) {
  mountIndex += 1
  return settleAt(Component, props, `mount${mountIndex}`)
}

/** 首次渲染用固定路径，方便后面的用例复用/对照。 */
function settle(Component, props) {
  return settleAt(Component, props, `first:${Component.name || 'anon'}`)
}

// ── 假 window / document / fetch ────────────────────────────────────────────
const styles = new Map()
const windowStub = {
  __ModuleLoader__: undefined,
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
  confirm: () => true,
}
const documentStub = {
  head: {
    appendChild(node) { styles.set(node.id, node); node.parentNode = documentStub.head },
  },
  getElementById: (id) => styles.get(id) ?? null,
  createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: undefined }),
}

const STATUS = {
  ok: true,
  accounts: [
    { id: 'acc-1', label: 'AWS Builder ID · us-east-1', method: 'builder-id', region: 'us-east-1', state: 'ready', active: true },
    { id: 'acc-2', label: 'Imported token · us-east-1', method: 'imported', region: 'us-east-1', state: 'refresh', active: false },
  ],
  activeAccountId: 'acc-1',
  credentialSource: 'managed',
  models: [
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000 },
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 32000 },
  ],
  enabledModels: ['claude-sonnet-4.5'],
  usage: {
    plan: 'KIRO PRO',
    rows: [
      { label: 'Credits', used: 40, limit: 100, resetAt: Date.parse('2026-11-01T00:00:00Z') },
      { label: 'Requests', used: 95, limit: 100, resetAt: Date.parse('2026-11-01T00:00:00Z') },
    ],
    fetchedAt: Date.parse('2026-10-26T03:00:00Z'),
  },
  proxy: {
    baseUrl: 'http://127.0.0.1:53984/v1',
    key: 'sk-local-test',
    openaiBaseUrl: 'http://127.0.0.1:53984/v1',
    anthropicBaseUrl: 'http://127.0.0.1:53984',
    enabled: true,
  },
  config: { proxyUrl: '', region: 'us-east-1', profileArn: '', maxContextWindow: 200000 },
  errors: ['Usage: GetUsageLimits throttled'],
}

const fetched = []
let statusOverride
async function fetchStub(url, options) {
  fetched.push({ url: String(url), options })
  const value = statusOverride === undefined ? STATUS : statusOverride(STATUS)
  return { ok: true, status: 200, async json() { return { ok: true, value } } }
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.fetch = fetchStub
// Node 22 的 globalThis.navigator 是 getter-only，直接赋值会 TypeError，
// 所以用 defineProperty 覆盖成测试用的语言 + clipboard。
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})

// ── 加载 client.js ──────────────────────────────────────────────────────────
let loaded
windowStub.__ModuleLoader__ = { load(descriptor) { loaded = descriptor } }
await import(`${pathToFileURL(clientPath).href}?t=${Date.now()}`)

log('== dsh-kiro-proxy client.js 离线自测 ==')
check('window.__ModuleLoader__.load 被调用', loaded !== undefined)
check('模块 id 为 dsh-kiro-proxy', loaded && loaded.id === 'dsh-kiro-proxy', loaded && loaded.id)

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
}
const exported = loaded.factory(requireStub)
check('factory 返回对象', typeof exported === 'object' && exported !== null)
check('inject 为 [slots, locale]', Array.isArray(exported.inject)
  && exported.inject.length === 2
  && exported.inject[0] === 'slots'
  && exported.inject[1] === 'locale', JSON.stringify(exported.inject))
check('apply 是函数', typeof exported.apply === 'function')

// ── 假 ctx ─────────────────────────────────────────────────────────────────
const injectCalls = []
const registerCalls = []
const localeRegistrations = []
let effectRuns = 0

const slots = {
  inject(name, factory) {
    injectCalls.push({ name, factory })
    // 宿主会在槽挂载时调用 factory，这里立刻调用以验证注册路径。
    return factory()
  },
  register(options, component) {
    registerCalls.push({ options, component })
    return () => {}
  },
}
const fakeCtx = {
  slots,
  locale: {
    register(ns, dictionary) { localeRegistrations.push({ ns, dictionary }) },
    bind(ns) {
      return (key) => {
        const entry = localeRegistrations.find(item => item.ns === ns)
        return entry ? entry.dictionary.zh[key] ?? key : key
      }
    },
    getLocale() { return { active: 'zh-CN' } },
  },
  effect(fn) {
    effectRuns += 1
    return fn()
  },
}

exported.apply(fakeCtx)

check('slots.inject 被调用两次', injectCalls.length === 2, String(injectCalls.length))
check('第一次 inject 是 settings.section', injectCalls[0] && injectCalls[0].name === 'settings.section', injectCalls[0] && injectCalls[0].name)
check('第二次 inject 是 conversation.input.right', injectCalls[1] && injectCalls[1].name === 'conversation.input.right', injectCalls[1] && injectCalls[1].name)
check('两次 inject 都传了 factory', injectCalls.every(call => typeof call.factory === 'function'))

const settingsOptions = registerCalls[0] && registerCalls[0].options
const quotaOptions = registerCalls[1] && registerCalls[1].options

check('settings.section 注册参数 name', settingsOptions && settingsOptions.name === 'settings.section', settingsOptions && settingsOptions.name)
check('settings.section id=kiro-proxy', settingsOptions && settingsOptions.id === 'kiro-proxy', settingsOptions && settingsOptions.id)
check('settings.section order=13', settingsOptions && settingsOptions.order === 13, settingsOptions && String(settingsOptions.order))
check('settings.section label 是函数', settingsOptions && typeof settingsOptions.label === 'function')
const labelText = settingsOptions && settingsOptions.label()
check('settings.section label 返回「Kiro Proxy」', labelText === 'Kiro Proxy', labelText)
check('settings.section 注册了组件', registerCalls[0] && typeof registerCalls[0].component === 'function')

check('conversation.input.right 注册参数 name', quotaOptions && quotaOptions.name === 'conversation.input.right', quotaOptions && quotaOptions.name)
check('conversation.input.right id=kiro-proxy-quota', quotaOptions && quotaOptions.id === 'kiro-proxy-quota', quotaOptions && quotaOptions.id)
check('conversation.input.right order=21', quotaOptions && quotaOptions.order === 21, quotaOptions && String(quotaOptions.order))
check('conversation.input.right locale=dsh-kiro-proxy', quotaOptions && quotaOptions.locale === 'dsh-kiro-proxy', quotaOptions && quotaOptions.locale)
check('conversation.input.right 注册了组件', registerCalls[1] && typeof registerCalls[1].component === 'function')

{
  const calls = []
  const dirCtx = {
    ...fakeCtx,
    slots: {
      inject(name, factory) { return factory() },
      register(options, component) { calls.push({ options, component }); return () => {} },
    },
    locale: { register() {}, bind: fakeCtx.locale.bind },
    effect: fakeCtx.effect,
    inject(names, callback) {
      callback({
        slots: dirCtx.slots,
        modelDirectories: { directoryFor: (sessionId) => ({ store: { sessionId, subscribe: () => () => {}, getSnapshot: () => undefined } }) },
      })
    },
  }
  exported.apply(dirCtx)
  const quotaReg = calls.find(call => call.options.name === 'conversation.input.right')
  check('有 modelDirectories 时徽标注册带 inject 选项', typeof quotaReg?.options?.inject === 'function')
  const injected = quotaReg?.options?.inject?.('session-42')
  check('inject 按 sessionId 取目录 store', injected?.directory?.sessionId === 'session-42', JSON.stringify(injected))
}

// ── locale ─────────────────────────────────────────────────────────────────
check('locale.register 被调用一次', localeRegistrations.length === 1, String(localeRegistrations.length))
const registration = localeRegistrations[0]
check('locale 命名空间是 dsh-kiro-proxy', registration && registration.ns === 'dsh-kiro-proxy', registration && registration.ns)
check('locale 字典含 en', Boolean(registration && registration.dictionary.en))
check('locale 字典含 zh', Boolean(registration && registration.dictionary.zh))
const enKeys = Object.keys(registration.dictionary.en).sort()
const zhKeys = Object.keys(registration.dictionary.zh).sort()
check('en/zh 键集合一致', JSON.stringify(enKeys) === JSON.stringify(zhKeys), `en=${enKeys.length} zh=${zhKeys.length}`)
check('字典非空（> 40 键）', enKeys.length > 40, String(enKeys.length))
log(`       locale keys: ${enKeys.length}`)

// ── 样式 ───────────────────────────────────────────────────────────────────
check('ctx.effect 被调用（样式注入走 effect）', effectRuns >= 1, String(effectRuns))
const styleNode = documentStub.getElementById('dsh-kiro-proxy-style')
check('<style id="dsh-kiro-proxy-style"> 已注入', styleNode !== undefined && styleNode !== null)
check('样式内容包含 dshkp- 前缀', Boolean(styleNode && styleNode.textContent.includes('.dshkp-wrap')))
check('样式只引用 dsh-alias token', Boolean(styleNode && styleNode.textContent.includes('var(--dsw-alias-')))

// ── 假渲染：设置页 ──────────────────────────────────────────────────────────
const settingsRender = await settle(registerCalls[0].component, { ctx: fakeCtx })
const settings = settingsRender
check('设置页渲染出账号行（dshkp-row）', settings.classes.some(name => name.startsWith('dshkp-row')), settings.classes.join(','))
check('设置页渲染出模型勾选框', settings.classes.includes('dshkp-check'))
check('设置页渲染出用量行', settings.classes.some(name => name.startsWith('dshkp-usage-row')))
check('设置页渲染出代理键值行', settings.classes.some(name => name.startsWith('dshkp-kv-row')))
check('设置页渲染出错误列表', settings.classes.includes('dshkp-errors'))
check('设置页文案为中文（含「账号」）', settings.blob.includes('账号'), settings.blob.slice(0, 160))
check('设置页显示当前账号徽章', settings.blob.includes('当前'))
check('设置页显示 plan', settings.blob.includes('KIRO PRO'))
check('设置页显示 OpenAI Base URL', settings.blob.includes('http://127.0.0.1:53984/v1'))
check('设置页显示用量 used/limit', settings.blob.includes('95 / 100'), settings.blob.slice(0, 200))
check('设置页有「轮换 Key」按钮文案', settings.blob.includes('轮换 Key'))
{
  const details = settings.elements.find(node => node && node.type === 'details')
  check('导入卡折进 <details>', Boolean(details), JSON.stringify(settings.classes.filter(c => c.startsWith('dshkp-'))))
  check('<details> 默认不收 open 属性（即收起）', Boolean(details) && details.props.open === undefined)
  const summary = settings.elements.find(node => node && node.type === 'summary')
  check('折叠标题是「添加账号」', Boolean(summary) && summary.children.includes('添加账号'), summary && JSON.stringify(summary.children))
  check('展开后可见「导入 refresh token」', settings.blob.includes('导入 refresh token'))
}

// 设置页的用量卡：进度条 + 剩余百分比 + 独立刷新
check('用量卡有进度条', settings.classes.includes('dshkp-usage-bar'), settings.classes.filter(c => c.startsWith('dshkp-usage')).join(','))
check('用量卡有剩余百分比文字', /剩余 \d+%/.test(settings.blob), settings.blob.slice(0, 200))
check('用量卡有「刷新用量」按钮', settings.texts.some(text => typeof text === 'string' && text.includes('刷新用量')), settings.texts.slice(0, 12).join(','))
{
  const before = fetched.filter(item => item.url.endsWith('/kiro-proxy/api/refresh')).length
  const usageRefresh = settings.elements.find(node => node && node.type === 'button'
    && node.children.some(child => typeof child === 'string' && child.includes('刷新用量')))
  if (usageRefresh) usageRefresh.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  const after = fetched.filter(item => item.url.endsWith('/kiro-proxy/api/refresh')).length
  check('「刷新用量」触发 POST /kiro-proxy/api/refresh', after === before + 1, `${before} -> ${after}`)
}

const statusReads = fetched.filter(item => item.url.endsWith('/kiro-proxy/api/status'))
check('组件通过 /kiro-proxy/api/status 取数', statusReads.length >= 1, String(statusReads.length))

// ── 假渲染：配额徽标 ────────────────────────────────────────────────────────
// 徽标只在「本会话选中 kiro-proxy 路由」时出现，选中状态来自 modelDirectories 的 store。
function fakeDirectory(current) {
  const listeners = new Set()
  let state = { current, status: 'ready' }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot() { return state },
    set(next) { state = { ...state, current: next }; for (const listener of listeners) listener() },
  }
}
const kiroDirectory = fakeDirectory({ provider: 'kiro-proxy', model: 'claude-sonnet-4.5' })
const quotaSlot = registerCalls[1].component
const quotaRender = await settle(quotaSlot, { ctx: fakeCtx, sessionId: 'session-1', directory: kiroDirectory })
check('配额徽标有渲染结果', quotaRender.tree !== null && quotaRender.tree !== undefined)
const quota = quotaRender
check('徽标 class 带 dshkp-quota', quota.classes.some(name => name.startsWith('dshkp-quota')), quota.classes.join(','))
check('徽标取最紧一行（Requests 95/100 -> 剩余 5%）', quota.blob.includes('剩余 5%'), quota.blob)
check('5% 落在 low（琥珀）而非 critical（红）', quota.classes.some(name => name.includes('dshkp-quota-low')), quota.classes.join(','))
const quotaButton = quota.elements.find(node => node && node.props && typeof node.props.className === 'string'
  && node.props.className.startsWith('dshkp-quota'))
check('徽标 title 带明细', Boolean(quotaButton && typeof quotaButton.props.title === 'string'
  && quotaButton.props.title.includes('Requests') && quotaButton.props.title.includes('KIRO PRO')),
  quotaButton && quotaButton.props.title)

// ── 边界：代理未启用 / 无启用模型 / 无用量 -> 不占位 ───────────────────────
// 注册的槽组件必须包一层才能拿到 ctx，所以它本身永远返回一个元素；
// “不占位”的真正含义是内层 QuotaChip 返回 null —— 渲染树里没有任何节点、没有任何文字。
function rendersNothing(rendered) {
  return rendered.classes.length === 0 && rendered.texts.length === 0
}

const statusReadsBeforeOther = fetched.filter(item => item.url.endsWith('/kiro-proxy/api/status')).length
const quotaOther = await settleFresh(quotaSlot, {
  ctx: fakeCtx, sessionId: 'session-1',
  directory: fakeDirectory({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }),
})
check('选中其他 provider 时徽标不渲染任何节点', rendersNothing(quotaOther), JSON.stringify(quotaOther.classes))
check('选中其他 provider 时不去读额度',
  fetched.filter(item => item.url.endsWith('/kiro-proxy/api/status')).length === statusReadsBeforeOther)

const quotaNoModel = await settleFresh(quotaSlot, { ctx: fakeCtx, sessionId: 'session-1', directory: fakeDirectory(null) })
check('未选模型时徽标不渲染任何节点', rendersNothing(quotaNoModel), JSON.stringify(quotaNoModel.classes))

const quotaNoDirectory = await settleFresh(quotaSlot, { ctx: fakeCtx, sessionId: 'session-1' })
check('宿主没有模型目录时徽标不渲染（不猜路由）', rendersNothing(quotaNoDirectory), JSON.stringify(quotaNoDirectory.classes))

const quotaLegacyKiro = await settleFresh(quotaSlot, {
  ctx: fakeCtx, sessionId: 'session-1',
  directory: fakeDirectory({ provider: 'kiro', model: 'claude-sonnet-4.5' }),
})
check('别的 Kiro 插件（provider=kiro）不触发本徽标', rendersNothing(quotaLegacyKiro), JSON.stringify(quotaLegacyKiro.classes))

statusOverride = (base) => ({ ...base, usage: null })
const quotaNoUsage = await settleFresh(quotaSlot, { ctx: fakeCtx, sessionId: 'session-1', directory: kiroDirectory })
check('没有用量数据时徽标不渲染任何节点', rendersNothing(quotaNoUsage), JSON.stringify(quotaNoUsage.classes))
statusOverride = undefined

// ── 交互：按钮点击真的打到契约里的端点 ────────────────────────────────────
// 只断言 URL + method，不模拟真实响应；响应形状由上面的渲染断言覆盖。
function findButton(rendered, label) {
  return rendered.elements.find(node => node && node.type === 'button'
    && node.children.some(child => typeof child === 'string' && child.includes(label)))
}

const callsBefore = fetched.length
const refreshButton = findButton(settings, '刷新')
check('设置页找到「刷新」按钮', Boolean(refreshButton), settings.texts.slice(0, 8).join(','))
if (refreshButton) refreshButton.props.onClick()
await new Promise(resolve => setTimeout(resolve, 10))
const refreshCall = fetched.slice(callsBefore).find(item => item.url.endsWith('/kiro-proxy/api/refresh'))
check('「刷新」调用 POST /kiro-proxy/api/refresh', Boolean(refreshCall) && refreshCall.options.method === 'POST',
  refreshCall && `${refreshCall.url} ${refreshCall.options.method}`)

// 模型勾选：POST /settings，payload 里是被勾选后的 enabledModels
const callsBeforeModel = fetched.length
const modelCheckbox = settings.elements.find(node => node && node.type === 'input' && node.props.type === 'checkbox')
check('设置页找到模型勾选框', Boolean(modelCheckbox))
if (modelCheckbox) modelCheckbox.props.onChange({ target: { checked: true } })
await new Promise(resolve => setTimeout(resolve, 10))
const modelCall = fetched.slice(callsBeforeModel).find(item => item.url.endsWith('/kiro-proxy/api/settings'))
check('勾选模型调用 POST /kiro-proxy/api/settings', Boolean(modelCall), modelCall && modelCall.url)
check('勾选 payload 带 enabledModels 数组',
  Boolean(modelCall) && Array.isArray(JSON.parse(modelCall.options.body).enabledModels),
  modelCall && modelCall.options.body)

// 复制按钮：写剪贴板
const callsBeforeCopy = fetched.length
const copyButton = settings.elements.find(node => node && node.type === 'button'
  && node.children.some(child => child === '复制'))
check('设置页找到「复制」按钮', Boolean(copyButton))
if (copyButton) await copyButton.props.onClick()
check('复制按钮不产生网络请求（只写剪贴板）', fetched.length === callsBeforeCopy)

// 徽标点击：POST /refresh 后重读 status
const chipButton = quota.elements.find(node => node && node.type === 'button'
  && typeof node.props.className === 'string' && node.props.className.startsWith('dshkp-quota'))
check('徽标是一个 button', Boolean(chipButton))
const callsBeforeChip = fetched.length
if (chipButton) chipButton.props.onClick()
await new Promise(resolve => setTimeout(resolve, 20))
const chipRefresh = fetched.slice(callsBeforeChip).find(item => item.url.endsWith('/kiro-proxy/api/refresh'))
check('点击徽标调用 POST /kiro-proxy/api/refresh', Boolean(chipRefresh) && chipRefresh.options.method === 'POST',
  chipRefresh && `${chipRefresh.url} ${chipRefresh.options.method}`)

// ── 边界：<5% 走 critical 红色 ─────────────────────────────────────────────
statusOverride = (base) => ({
  ...base,
  usage: { ...base.usage, rows: [{ label: 'Credits', used: 97, limit: 100, resetAt: base.usage.rows[0].resetAt }] },
})
const quotaCritical = await settleFresh(quotaSlot, { ctx: fakeCtx, sessionId: 'session-1', directory: kiroDirectory })
check('剩余 3% 走 critical 红色', quotaCritical.classes.some(name => name.includes('dshkp-quota-critical')), quotaCritical.classes.join(','))
check('critical 时显示「剩余 3%」', quotaCritical.blob.includes('剩余 3%'), quotaCritical.blob)
statusOverride = undefined

// ── 边界：fetch 抛错 -> 一行错误文字，不抛异常 ──────────────────────────────
const healthyFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('network down') }
let settingsFailed
try {
  settingsFailed = await settleFresh(registerCalls[0].component, { ctx: fakeCtx })
} catch (error) {
  settingsFailed = { classes: [], texts: [], blob: '', threw: String(error && error.message) }
}
check('fetch 抛错时设置页不抛出异常', settingsFailed.threw === undefined, settingsFailed.threw)
check('fetch 抛错时渲染一行错误文字', settingsFailed.blob.includes('请求失败') && settingsFailed.blob.includes('network down'),
  settingsFailed.blob.slice(0, 160))
check('fetch 抛错时仍渲染标题与刷新按钮', settingsFailed.blob.includes('Kiro Proxy') && settingsFailed.blob.includes('刷新'), settingsFailed.blob.slice(0, 120))
globalThis.fetch = healthyFetch

// ── 清理函数可调用 ─────────────────────────────────────────────────────────
let cleanupOk = true
for (const frame of frames.values()) {
  for (const hook of frame.hooks) {
    if (typeof hook === 'function') {
      try { hook() } catch (error) { cleanupOk = false; log(`      cleanup error: ${error && error.message}`) }
    }
  }
}
check('effect 清理函数可调用（样式可移除）', cleanupOk)

// ── 结论 ───────────────────────────────────────────────────────────────────
log('')
const passed = lines.filter(line => line.startsWith('PASS')).length
log(failures.length === 0 ? `RESULT: ALL PASS (${passed} checks)` : `RESULT: ${failures.length} FAILED -> ${failures.join(', ')}`)
log('未覆盖：真实浏览器渲染、真实 React 更新语义、真实 Host API 的返回值与 HTTP 状态。')

mkdirSync(here, { recursive: true })
writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8')
process.exitCode = failures.length === 0 ? 0 : 1
