/**
 * dsh-kiro-proxy — Kiro (AWS CodeWhisperer) as a Harness provider route, plus a
 * reverse proxy in front of it.
 *
 * Two surfaces, one account:
 *
 * - `ctx.llm.registerAdapter(['kiro-proxy'], …)` puts the Kiro route in the
 *   Harness model picker, so a session streams from Kiro exactly like any other
 *   provider.
 * - `webServer` routes expose `/v1/chat/completions`, `/v1/messages`, and
 *   `/v1/models`, so a CLI that only speaks one of those protocols reaches the
 *   same Kiro account without knowing anything about Kiro.
 *
 * Credentials are never part of the composition: the plugin reads whatever Kiro
 * IDE/CLI already signed in with, and an optional plugin-owned store holds
 * additional accounts.
 *
 * @module dsh-kiro-proxy
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { KiroProxyAdapter } from './lib/adapter.js'
import { AccountStore, storageDirectory } from './lib/kiro-auth.js'
import { KiroClient } from './lib/kiro-client.js'
import { ProxyKeyStore, createProxyHandlers } from './lib/web.js'

/**
 * The single provider route this plugin owns.
 */
export const PROVIDER = 'kiro-proxy'
/** Plugin name, matching the package and the patch row. */
export const name = 'dsh-kiro-proxy'
/**
 * The `llm` service is a hard dependency: without it there is no route to
 * register, and a plugin that activates anyway would only fail later at the
 * first model call. `webServer` stays optional so a headless profile still gets
 * the adapter without the reverse proxy.
 */
export const inject = ['llm']
/** Settings namespace, matching the `kiro-proxy:` block in `settings.yaml`. */
const NS = 'kiro-proxy'

/**
 * The user-editable settings document, stored beside the accounts.
 *
 * A file rather than `settings.yaml` because every field is hot-editable from
 * the settings page, and writing the user's global settings file from a plugin
 * would fight the Harness configuration editor for the same document.
 */
class SettingsStore {
  /**
   * @param {string} [directory] - storage directory override.
   */
  constructor(directory = storageDirectory()) {
    this.directory = directory
    this.path = join(directory, 'settings.json')
    this.cached = undefined
  }

  /**
   * Read the stored settings, tolerating an absent file.
   * @returns {Promise<Record<string, unknown>>} the stored settings.
   */
  async read() {
    if (this.cached !== undefined) return this.cached
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      this.cached = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.cached = {}
    }
    return this.cached
  }

  /**
   * Merge one patch into the stored settings and persist it.
   * @param {Record<string, unknown>} patch - fields to change; `null` removes one.
   * @returns {Promise<Record<string, unknown>>} the merged settings.
   */
  async merge(patch) {
    const current = { ...await this.read() }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') delete current[key]
      else current[key] = value
    }
    await mkdir(this.directory, { recursive: true })
    await writeFile(this.path, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    this.cached = current
    return current
  }
}

/**
 * Mount the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - the row's configuration.
 */
export function apply(ctx, config = {}) {
  const settings = new SettingsStore()
  const store = new AccountStore()
  const keys = new ProxyKeyStore()

  /**
   * Live connection facts: the profile row first, then the stored settings.
   *
   * The row is what a deployment pins, and the store is what the settings page
   * writes, so the row wins — a user who pins `proxyUrl` in `cordis.patch.yml`
   * must not have it silently replaced by a click in the UI.
   * @returns {Record<string, unknown>} the merged facts.
   */
  const readOptions = () => ({ ...(settings.cached ?? {}), ...config })
  // Prime the cache so the first request does not race the settings read.
  settings.read().then(value => {
    settings.cached = { ...value, ...config }
  }).catch(() => {
    settings.cached = { ...config }
  })

  const client = new KiroClient({ store, options: readOptions })
  const adapter = new KiroProxyAdapter({
    client,
    provider: PROVIDER,
    displayName: 'Kiro Proxy',
    cap: () => {
      const value = readOptions().maxContextWindow
      return Number.isInteger(value) && value > 0 ? value : undefined
    },
  })

  // A declared provider route makes the route appear in the models settings
  // even before a credential exists, so the failure reads as "sign in" rather
  // than as a missing provider.
  ctx.effect(() => ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'Kiro Proxy',
    settingsNs: NS,
    settingsPath: [],
  }]))

  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))

  ctx.inject(['webServer'], webCtx => {
    const handlers = createProxyHandlers({
      client,
      store,
      keys,
      baseUrl: () => webCtx.webServer.getOrigin(),
      requireKey: () => readOptions().requireProxyKey === true,
      updateSettings: patch => settings.merge(patch),
    })
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/v1',
      handler: async (request, response) => {
        const rawUrl = request.url || '/'
        const url = new URL(rawUrl, 'http://dsh.local')
        const path = url.pathname.replace(/^\/v1\/?/u, '')
        const isModels = path === 'models'
        if (isModels && request.method === 'GET') {
          await handlers.models(request, response)
          return
        }
        if (path === 'chat/completions' && request.method === 'POST') {
          await handlers.openai(request, response)
          return
        }
        if (path === 'messages' && request.method === 'POST') {
          await handlers.anthropic(request, response)
          return
        }
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          error: {
            message: `Kiro proxy has no route for ${request.method ?? 'GET'} /v1/${path}`,
            type: 'not_found',
          },
        }))
      },
    }))
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/kiro-proxy/api',
      handler: (request, response) => handlers.api(request, response),
    }))
  })
}
