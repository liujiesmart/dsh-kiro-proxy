/**
 * The reverse proxy: an OpenAI-compatible and an Anthropic-compatible surface
 * in front of Kiro, plus the small state API the settings page reads.
 *
 * This is the piece that makes the plugin usable from outside the Harness 鈥?a
 * CLI that only speaks `/v1/chat/completions`, or Claude Code speaking
 * `/v1/messages`, reaches the same Kiro account the Harness adapter uses. Both
 * surfaces therefore share one credential, one catalog, and one usage reading.
 *
 * @module dsh-kiro-proxy/web
 */

import * as nodeCrypto from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { errorText } from './kiro-error.js'
import { AccountStore, importCredential, storageDirectory } from './kiro-auth.js'
import {
  anthropicResponse,
  anthropicStart,
  anthropicStop,
  anthropicToWire,
  newAnthropicState,
  wireToAnthropicEvent,
} from './kiro-anthropic.js'
import {
  newOpenAiState,
  openAiToWire,
  wireFinish,
  wireToOpenAiChunk,
  wireToOpenAiResponse,
} from './kiro-openai.js'

/** Largest request body this proxy accepts, in bytes. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** Headers carrying the proxy's own key, in both common spellings. */
const KEY_HEADERS = ['x-api-key', 'authorization']
/** Media type of every JSON body this module writes. */
const JSON_CONTENT_TYPE = ['application/json', 'charset=utf-8'].join('; ')

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the value to serialize.
 */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  const headers = {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  response.writeHead(status, headers)
  response.end(payload)
}

/**
 * Write one JSON error in the shape the caller's surface expects.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {string} message - diagnosis.
 * @param {'openai'|'anthropic'|'plain'} shape - which error envelope to use.
 */
function sendError(response, status, message, shape = 'openai') {
  if (shape === 'anthropic') {
    sendJson(response, status, { type: 'error', error: { type: 'api_error', message } })
    return
  }
  if (shape === 'openai') {
    sendJson(response, status, { error: { message, type: 'kiro_proxy_error', code: String(status) } })
    return
  }
  sendJson(response, status, { ok: false, error: message })
}

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<Record<string, unknown>>} the parsed body.
 */
async function readJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body is too large for the Kiro proxy')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const object = record(value)
  if (object === undefined) throw new Error('Request body must be a JSON object')
  return object
}

/**
 * Map a failure class onto the HTTP status the caller should see.
 *
 * A malformed request from the client is not an upstream failure: answering 502
 * for it sends the user to debug their network instead of their request body.
 * @param {unknown} error - anything caught.
 * @returns {number} the status to answer with.
 */
function statusFor(error) {
  const code = typeof error === 'object' && error !== null ? error.code : undefined
  switch (code) {
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_CONTENT':
    case 'UNSUPPORTED_TOOL_NAME':
    case 'UNSUPPORTED_REASONING_EFFORT':
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 400
    case 'AUTH':
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return 401
    case 'FORBIDDEN':
      return 403
    case 'QUOTA':
      return 402
    case 'RATE_LIMIT':
      return 429
    case 'ABORTED':
      return 499
    default:
      return 502
  }
}

/**
 * Own the proxy key: read the stored one, or mint and persist one on first use.
 *
 * The key exists so that a proxy bound to a non-loopback address is not an open
 * relay. It is generated rather than configured, because a default key shipped
 * in a package is not a secret.
 */
export class ProxyKeyStore {
  /**
   * @param {string} [directory] - storage directory override.
   */
  constructor(directory = storageDirectory()) {
    this.directory = directory
    this.path = join(directory, 'proxy-key')
    this.key = undefined
  }

  /**
   * Read the key, minting one when absent.
   * @returns {Promise<string>} the key.
   */
  async get() {
    if (this.key !== undefined) return this.key
    try {
      const value = (await readFile(this.path, 'utf8')).trim()
      if (value.length > 0) {
        this.key = value
        return value
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return this.rotate()
  }

  /**
   * Replace the key.
   * @returns {Promise<string>} the new key.
   */
  async rotate() {
    const key = 'kr-' + nodeCrypto.randomBytes(24).toString('base64url')
    await mkdir(this.directory, { recursive: true })
    await writeFile(this.path, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
    this.key = key
    return key
  }
}

/**
 * Decide whether one request may use the proxy.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string} expected - the proxy key.
 * @param {boolean} required - whether a key is demanded at all.
 * @returns {boolean} true when the request is authorized.
 */
function authorized(request, expected, required) {
  if (!required) return true
  for (const header of KEY_HEADERS) {
    const raw = request.headers[header]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string') continue
    const candidate = header === 'authorization' ? value.replace(/^Bearer\s+/iu, '') : value
    if (candidate === expected) return true
  }
  return false
}

/**
 * The per-call facts `sendWire` needs beyond the body itself.
 *
 * Only the model's advertised capacity is here, and only so that a route which
 * reports no token buckets can still be priced from the provider's own context
 * percentage instead of from a local guess.
 * @param {{ contextWindow?: number }} context - the wire context resolved for this call.
 * @returns {{ contextWindow?: number }} the extra arguments.
 */
function wireExtra(context) {
  return context.contextWindow === undefined ? {} : { contextWindow: context.contextWindow }
}

/**
 * Build the proxy's route handlers.
 *
 * @param {{
 *   client: import('./kiro-client.js').KiroClient,
 *   store: AccountStore,
 *   keys: ProxyKeyStore,
 *   updateSettings: (patch: Record<string, unknown>) => Promise<object>,
 *   baseUrl: () => string,
 *   requireKey: () => boolean,
 * }} deps
 * @returns {{ status: () => Promise<object>, api: Function, openai: Function, anthropic: Function, models: Function }}
 */
export function createProxyHandlers(deps) {
  const { client, store, keys } = deps

  /**
   * Assemble everything the settings page shows in one round trip.
   * @returns {Promise<object>} the status document.
   */
  async function status() {
    const errors = []
    const accounts = await store.describe().catch(error => {
      errors.push(`Account store: ${errorText(error)}`)
      return { activeId: null, accounts: [] }
    })
    let models = []
    try {
      models = await client.models(undefined, false)
    } catch (error) {
      errors.push(`Models: ${errorText(error)}`)
    }
    let usage
    try {
      usage = await client.usage(undefined, false)
    } catch (error) {
      // A quota reading failure must not disable chat, so it is reported and the
      // last successful reading (or nothing) is shown instead.
      errors.push(`Usage: ${errorText(error)}`)
    }
    const connection = client.connection()
    const origin = deps.baseUrl()
    return {
      ok: true,
      accounts: accounts.accounts,
      activeAccountId: accounts.activeId,
      credentialSource: accounts.accounts.length > 0
        ? 'managed'
        : models.length > 0 ? 'kiro-cache' : 'none',
      models: models.map(model => ({
        id: model.id,
        name: model.name ?? model.id,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
        ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
        ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
        supportsEffort: model.supportsEffort === true,
      })),
      enabledModels: connection.enabledModels ?? models.map(model => model.id),
      usage: usage ?? null,
      proxy: {
        baseUrl: `${origin}/v1`,
        openaiBaseUrl: `${origin}/v1`,
        anthropicBaseUrl: origin,
        key: await keys.get(),
        requireKey: deps.requireKey(),
        enabled: true,
      },
      config: {
        proxyUrl: connection.proxyUrl,
        region: connection.region,
        profileArn: connection.profileArn,
        maxContextWindow: connection.maxContextWindow,
        fallbackOnEmpty: connection.fallbackOnEmpty !== false,
        fallbackModels: connection.fallbackModels ?? null,
      },
      // 空响应自动换模型的最近一次记录：设置页据此解释"为什么回答不是这个模型给的"。
      lastFallback: client.lastFallback ?? null,
      errors,
    }
  }

  /**
   * Handle the state API under `/kiro-proxy/api`.
   * @param {import('node:http').IncomingMessage} request - the request.
   * @param {import('node:http').ServerResponse} response - the response.
   */
  async function api(request, response) {
    const rawUrl = request.url || '/'
    const url = new URL(rawUrl, 'http://dsh.local')
    const path = url.pathname.replace(/^\/kiro-proxy\/api\/?/u, '')
    const isPost = request.method === 'POST'
    try {
      const isStatus = path === '' || path === 'status'
      if (isStatus && request.method === 'GET') {
        const result = await status()
        sendJson(response, 200, { ok: true, value: result })
        return
      }
      if (path === 'refresh' && request.method === 'POST') {
        client.clear()
        const result = await status()
        sendJson(response, 200, { ok: true, value: result })
        return
      }
      if (path === 'settings' && request.method === 'POST') {
        const body = await readJson(request)
        const value = await deps.updateSettings(body)
        client.clear()
        const currentStatus = await status()
        sendJson(response, 200, { ok: true, value, status: currentStatus })
        return
      }
      if (path === 'proxy-key' && request.method === 'POST') {
        const key = await keys.rotate()
        sendJson(response, 200, { ok: true, value: { key } })
        return
      }
      if (path === 'accounts/use' && request.method === 'POST') {
        const body = await readJson(request)
        const id = text(body.id)
        if (id === undefined) throw new Error('id is required')
        await store.use(id)
        client.clear()
        const result = await status()
        sendJson(response, 200, { ok: true, value: result })
        return
      }
      if (path === 'accounts/import' && request.method === 'POST') {
        const body = await readJson(request)
        const imported = importCredential({
          json: text(body.json),
          refreshToken: text(body.refreshToken),
          apiKey: text(body.apiKey),
          label: text(body.label),
        })
        const account = await store.save(imported)
        client.clear()
        const currentStatus = await status()
        sendJson(response, 200, { ok: true, value: { account, status: currentStatus } })
        return
      }
      const isRemove = path === 'accounts/remove'
      if (isRemove && isPost) {
        const body = await readJson(request)
        const id = text(body.id)
        if (id === undefined) throw new Error('id is required')
        await store.remove(id)
        client.clear()
        const result = await status()
        sendJson(response, 200, { ok: true, value: result })
        return
      }
      if (path === 'accounts/signout' && request.method === 'POST') {
        await store.clear()
        client.clear()
        const result = await status()
        sendJson(response, 200, { ok: true, value: result })
        return
      }
      sendError(response, 404, `Unknown Kiro proxy endpoint "${path}"`, 'plain')
    } catch (error) {
      sendError(response, 400, errorText(error), 'plain')
    }
  }

  /**
   * Write one SSE frame.
   * @param {import('node:http').ServerResponse} response - the response.
   * @param {string} data - the payload.
   * @param {string} [event] - optional event name.
   */
  function writeSse(response, data, event) {
    response.write(`${event === undefined ? '' : `event: ${event}\n`}data: ${data}\n\n`)
  }

  /**
   * Serve `/v1/models`.
   * @param {import('node:http').IncomingMessage} request - the request.
   * @param {import('node:http').ServerResponse} response - the response.
   */
  async function models(request, response) {
    if (!authorized(request, await keys.get(), deps.requireKey())) {
      sendError(response, 401, 'Invalid Kiro proxy API key', 'openai')
      return
    }
    try {
      const catalog = await client.models(undefined, false)
      // The model checkbox in the settings page is a routing choice, so the
      // protocol surfaces honor it: a client that lists models must see the same
      // set the Harness model picker offers, or the two disagree about what this
      // account may run.
      const enabled = client.connection().enabledModels
      const visible = enabled === undefined || enabled.length === 0
        ? catalog
        : catalog.filter(model => enabled.includes(model.id))
      sendJson(response, 200, {
        object: 'list',
        data: visible.map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'kiro',
          ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
        })),
      })
    } catch (error) {
      sendError(response, statusFor(error), errorText(error), 'openai')
    }
  }

  /**
   * Serve `/v1/chat/completions`.
   * @param {import('node:http').IncomingMessage} request - the request.
   * @param {import('node:http').ServerResponse} response - the response.
   */
  async function openai(request, response) {
    if (!authorized(request, await keys.get(), deps.requireKey())) {
      sendError(response, 401, 'Invalid Kiro proxy API key', 'openai')
      return
    }
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      sendError(response, 400, errorText(error), 'openai')
      return
    }
    const abort = new AbortController()
    response.once('close', () => abort.abort('client closed'))
    try {
      const model = text(body.model) ?? 'auto'
      const context = await client.wireContext(model, text(body.reasoning_effort))
      const wire = openAiToWire(body, context)
      const state = newOpenAiState({ model: wire.model })
      if (wire.stream !== true) {
        for await (const event of client.sendWire(wire.body, abort.signal, wireExtra(context))) wireToOpenAiChunk(event, state)
        wireFinish(state, state.stopReason)
        sendJson(response, 200, wireToOpenAiResponse(state))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      for await (const event of client.sendWire(wire.body, abort.signal, wireExtra(context))) {
        const piece = wireToOpenAiChunk(event, state)
        if (piece !== undefined) writeSse(response, piece)
      }
      writeSse(response, wireFinish(state, state.stopReason))
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      if (response.headersSent) {
        writeSse(response, JSON.stringify({ error: { message: errorText(error), type: 'kiro_proxy_error' } }))
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      sendError(response, statusFor(error), errorText(error), 'openai')
    }
  }

  /**
   * Serve `/v1/messages` (Anthropic Messages).
   * @param {import('node:http').IncomingMessage} request - the request.
   * @param {import('node:http').ServerResponse} response - the response.
   */
  async function anthropic(request, response) {
    if (!authorized(request, await keys.get(), deps.requireKey())) {
      sendError(response, 401, 'Invalid Kiro proxy API key', 'anthropic')
      return
    }
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      sendError(response, 400, errorText(error), 'anthropic')
      return
    }
    const abort = new AbortController()
    response.once('close', () => abort.abort('client closed'))
    try {
      const model = text(body.model) ?? 'auto'
      const context = await client.wireContext(model)
      const wire = anthropicToWire(body, context)
      const state = newAnthropicState({ model: wire.model })
      if (wire.stream !== true) {
        for await (const event of client.sendWire(wire.body, abort.signal, wireExtra(context))) wireToAnthropicEvent(event, state)
        anthropicStop(state, state.stopReason)
        sendJson(response, 200, anthropicResponse(state))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      writeSse(response, anthropicStart(state), 'message_start')
      for await (const event of client.sendWire(wire.body, abort.signal, wireExtra(context))) {
        const piece = wireToAnthropicEvent(event, state)
        if (piece !== undefined) writeSse(response, piece.data, piece.event)
      }
      for (const piece of anthropicStop(state, state.stopReason)) writeSse(response, piece.data, piece.event)
      response.end()
    } catch (error) {
      if (response.headersSent) {
        writeSse(
          response,
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorText(error) } }),
          'error',
        )
        response.end()
        return
      }
      sendError(response, statusFor(error), errorText(error), 'anthropic')
    }
  }

  return { status, api, openai, anthropic, models }
}

