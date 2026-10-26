/**
 * Host smoke test: mount the plugin into a fake Cordis context.
 *
 * The point is not to emulate Cordis — it is to prove that `apply` registers
 * exactly the resources it should, that every registration is disposed through
 * `ctx.effect`, and that the reverse-proxy routes land on the paths the settings
 * page and the CLIs expect. A missing `ctx.effect` here would be a leak in the
 * real Host, which is the failure this catches cheapest.
 *
 * Run: node .scratch/host-smoke.mjs
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// 存储目录隔离，别碰真实 $DSH_HOME。
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'kiro-proxy-smoke-'))

const { apply, inject, PROVIDER } = await import('../index.js')

check('导出 apply', typeof apply === 'function')
check('导出 inject 含 llm', Array.isArray(inject) && inject.includes('llm'), JSON.stringify(inject))
check('PROVIDER 名', PROVIDER === 'kiro-proxy', PROVIDER)

const effects = []
const adapters = []
const configurable = []
const routes = []
const injections = []

const llm = {
  registerAdapter(providers, adapter) {
    adapters.push({ providers, adapter })
    return () => {
      adapters.length = 0
    }
  },
  registerConfigurableProviders(entries) {
    configurable.push(...entries)
    return () => {
      configurable.length = 0
    }
  },
}

const webServer = {
  getOrigin: () => 'http://127.0.0.1:53984',
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

const ctx = {
  llm,
  effect(factory) {
    const dispose = factory()
    effects.push(dispose)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(names, callback) {
    injections.push(names)
    if (names.includes('webServer')) callback({ webServer, effect: ctx.effect })
  },
}

apply(ctx, {})

check('注册了一个 adapter', adapters.length === 1, adapters.length)
check('adapter 路由是 kiro-proxy', adapters[0]?.providers?.join(',') === 'kiro-proxy', JSON.stringify(adapters[0]?.providers))
check('adapter 实现了 prepareCall', typeof adapters[0]?.adapter?.prepareCall === 'function')
check('adapter 实现了 listModels', typeof adapters[0]?.adapter?.listModels === 'function')
check('adapter 实现了 resolveModel', typeof adapters[0]?.adapter?.resolveModel === 'function')
check('adapter 实现了 stream', typeof adapters[0]?.adapter?.stream === 'function')
check('adapter 实现了 providerInfo', typeof adapters[0]?.adapter?.providerInfo === 'function')

check('声明了可配置 provider', configurable.length === 1, configurable.length)
check('可配置 provider 的 id', configurable[0]?.provider === 'kiro-proxy', JSON.stringify(configurable[0]))
check('可配置 provider 的 settingsNs', configurable[0]?.settingsNs === 'kiro-proxy', configurable[0]?.settingsNs)

check('注入了 webServer', injections.some(names => names.includes('webServer')), JSON.stringify(injections))

const paths = routes.map(route => `${route.kind} ${route.path}`)
check('/v1 路由已挂', paths.includes('prefix /v1'), paths.join(' | '))
check('/kiro-proxy/api 路由已挂', paths.includes('prefix /kiro-proxy/api'), paths.join(' | '))
check('每条路由都是 prefix', routes.every(route => route.kind === 'prefix'), paths.join(' | '))
check('每条路由都有 handler', routes.every(route => typeof route.handler === 'function'))

// 卸载必须能清干净：每个 effect 的 disposer 都得真的撤掉注册。
const disposeAll = effects.filter(effect => typeof effect === 'function')
check('每个注册都有 disposer', disposeAll.length >= 2, disposeAll.length)
for (const dispose of disposeAll) dispose()
check('卸载后 adapter 撤掉', adapters.length === 0, adapters.length)
check('卸载后可配置 provider 撤掉', configurable.length === 0, configurable.length)
check('卸载后路由撤掉', routes.length === 0, routes.length)

// ---------------------------------------------------------------------------
// 路由分发：直接调 handler，确认路径解析与 404 行为
// ---------------------------------------------------------------------------
{
  const fresh = []
  const localCtx = {
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
    },
    effect: factory => {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject: (names, callback) => {
      if (!names.includes('webServer')) return
      callback({
        webServer: {
          getOrigin: () => 'http://127.0.0.1:1',
          register(route) {
            fresh.push(route)
            return () => {}
          },
        },
        effect: factory => {
          const dispose = factory()
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        },
      })
    },
  }
  apply(localCtx, {})
  const v1 = fresh.find(route => route.path === '/v1')
  const api = fresh.find(route => route.path === '/kiro-proxy/api')

  const respond = async handler => {
    const written = { status: 0, headers: {}, body: '' }
    const response = {
      writeHead(status, headers) {
        written.status = status
        written.headers = headers ?? {}
        return this
      },
      write(chunk) {
        written.body += chunk
      },
      end(chunk) {
        if (typeof chunk === 'string') written.body += chunk
      },
      once() {},
      setHeader() {},
    }
    const request = { url: '', method: 'GET', headers: {}, once() {} }
    await handler(request, response)
    return written
  }

  const unknown = await respond((request, response) => {
    request.url = '/v1/embeddings'
    request.method = 'POST'
    return v1.handler(request, response)
  })
  check('/v1 未知路径 -> 404', unknown.status === 404, unknown.status)
  check('/v1 404 是 JSON 错误体', unknown.body.includes('"type":"not_found"'), unknown.body.slice(0, 120))

  const apiUnknown = await respond((request, response) => {
    request.url = '/kiro-proxy/api/nope'
    request.method = 'GET'
    return api.handler(request, response)
  })
  check('API 未知路径 -> 404', apiUnknown.status === 404, apiUnknown.status)

  // status 端点会真的去读凭据；这台机器有 Kiro 登录态，所以只断言形状。
  const status = await respond((request, response) => {
    request.url = '/kiro-proxy/api/status'
    request.method = 'GET'
    return api.handler(request, response)
  })
  check('status 200', status.status === 200, status.status)
  const parsed = JSON.parse(status.body)
  check('status.ok', parsed.ok === true, parsed.ok)
  check('status 有 value', typeof parsed.value === 'object' && parsed.value !== null)
  check('status 有 proxy 块', typeof parsed.value?.proxy?.openaiBaseUrl === 'string', JSON.stringify(parsed.value?.proxy))
  check('status 有 accounts 数组', Array.isArray(parsed.value?.accounts), typeof parsed.value?.accounts)
  check('status 有 models 数组', Array.isArray(parsed.value?.models), typeof parsed.value?.models)
  check('status 有 errors 数组', Array.isArray(parsed.value?.errors), typeof parsed.value?.errors)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
