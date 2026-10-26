/**
 * HTTPS transport with optional HTTP(S) proxy egress.
 *
 * `fetch` cannot be pointed at a proxy without a custom dispatcher, and Kiro
 * authorizes model families by request egress: from an egress Kiro does not
 * recognize, a `claude-*` route answers `INVALID_MODEL` while the open-weight
 * routes keep working. Node's `http`/`tls` modules already express exactly
 * that — a `CONNECT` tunnel with TLS negotiated inside it — so proxy support
 * costs no dependency, and a proxied request differs from a direct one only in
 * how its socket is obtained.
 *
 * @module dsh-kiro-proxy/transport
 */

import * as http from 'node:http'
import * as https from 'node:https'
import * as tls from 'node:tls'
import { kiroError } from './kiro-error.js'

/** Default port for each proxy scheme this transport can open. */
const PROXY_PORTS = { 'http:': 80, 'https:': 443 }

const JSON_TYPE = 'application/json'

/** Explicit port from a URL, or the given fallback when the URL names none. */
function portOf(url, fallback) {
  return url.port === '' ? fallback : Number(url.port)
}

/** `{ proxyUrl }` when one is configured, otherwise nothing to spread. */
function egress(proxyUrl) {
  if (proxyUrl === undefined) return {}
  return { proxyUrl }
}

/** Basic proxy credentials from the URL's userinfo, if it carries any. */
function proxyAuthHeaders(proxy) {
  if (proxy.username === '') return {}
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  const encoded = Buffer.from(user + ':' + pass).toString('base64')
  return { 'proxy-authorization': 'Basic ' + encoded }
}

/**
 * Parse and check a configured proxy URL.
 * @param {string} raw - the configured proxy URL.
 * @returns {URL} the parsed URL.
 */
export function parseProxyUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch (error) {
    throw kiroError(`Kiro proxyUrl "${raw}" is not a valid URL`, 'INVALID_REQUEST', { cause: error })
  }
  if (!Object.hasOwn(PROXY_PORTS, url.protocol)) {
    throw kiroError(
      `Kiro proxyUrl scheme "${url.protocol}" is not supported; use http:// or https://`,
      'INVALID_REQUEST',
    )
  }
  if (!url.hostname) {
    throw kiroError(`Kiro proxyUrl "${raw}" names no host`, 'INVALID_REQUEST')
  }
  return url
}

/**
 * Ask the proxy for a raw TCP tunnel to the target with an HTTP `CONNECT`.
 * @param {URL} proxy - the validated proxy URL.
 * @param {string} host - target hostname.
 * @param {number} port - target port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} the tunneled socket, ready for TLS.
 */
function openTunnel(proxy, host, port, signal) {
  const authority = `${host}:${port}`
  const lib = proxy.protocol === 'https:' ? https : http
  const req = lib.request({
    host: proxy.hostname,
    port: portOf(proxy, PROXY_PORTS[proxy.protocol]),
    method: 'CONNECT',
    path: authority,
    signal,
    headers: { host: authority, ...proxyAuthHeaders(proxy) },
  })
  const settled = new Promise((resolve, reject) => {
    req.once('connect', (response, socket) => {
      const status = response.statusCode
      if (status === 200) {
        resolve(socket)
      } else {
        socket.destroy()
        reject(kiroError(
          `Kiro proxy ${proxy.host} refused CONNECT with HTTP ${String(status)}`,
          'TRANSPORT',
        ))
      }
    })
    req.on('error', err => {
      reject(kiroError(`Kiro proxy ${proxy.host} connection failed`, 'TRANSPORT', { cause: err }))
    })
  })
  req.end()
  return settled
}

/**
 * Send one request and resolve as soon as response headers arrive, so the
 * caller streams the body itself.
 * @param {{ url: string, method: 'GET'|'POST', headers: Record<string,string>, body?: string, signal: AbortSignal, proxyUrl?: string }} options
 * @returns {Promise<{ status: number, headers: Record<string, unknown>, body: AsyncIterable<Uint8Array> }>}
 */
async function send(rawOptions) {
  // 某些调用点（目录/用量）不带 signal；统一给一个，错误分类里就不用到处判空。
  const options = rawOptions.signal === undefined
    ? { ...rawOptions, signal: new AbortController().signal }
    : rawOptions
  const target = new URL(options.url)
  const targetPort = portOf(target, 443)
  let tunnel
  if (options.proxyUrl !== undefined) {
    tunnel = await openTunnel(parseProxyUrl(options.proxyUrl), target.hostname, targetPort, options.signal)
  }

  const requestOptions = {
    host: target.hostname,
    port: targetPort,
    path: target.pathname + target.search,
    method: options.method,
    signal: options.signal,
    headers: { ...options.headers },
  }
  if (options.body !== undefined) {
    requestOptions.headers['content-length'] = String(Buffer.byteLength(options.body))
  }
  // 隧道 socket 已经直连目标，TLS 必须在它上面按目标的 SNI 自己握手；
  // 代理因此只看到密文，bearer token 不会以明文经过它。
  if (tunnel !== undefined) {
    requestOptions.createConnection = () => tls.connect({ socket: tunnel, servername: target.hostname })
  }

  const settled = new Promise((resolve, reject) => {
    const req = https.request(requestOptions, response => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response })
    })
    req.once('error', err => {
      if (tunnel) tunnel.destroy()
      const why = options.signal.aborted ? 'ABORTED' : 'TRANSPORT'
      const msg = options.signal.aborted
        ? 'Kiro request aborted by caller'
        : `Kiro request to ${target.host} failed`
      reject(kiroError(msg, why, { cause: err }))
    })
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
  return settled
}

/**
 * POST one request without reading its body.
 * @param {{ url: string, headers: Record<string,string>, body: string, signal: AbortSignal, proxyUrl?: string }} options
 */
export function post(options) {
  const forced = { method: 'POST' }
  return send(Object.assign({}, options, forced))
}

/**
 * GET one request without reading its body.
 * @param {{ url: string, headers: Record<string,string>, signal: AbortSignal, proxyUrl?: string }} options
 */
export function get(options) {
  const forced = { method: 'GET' }
  return send(Object.assign({}, options, forced))
}

/**
 * Read a whole response as text.
 * @param {{ body: AsyncIterable<Uint8Array> }} response - a `send` result.
 * @returns {Promise<string>} the decoded body.
 */
export async function responseText(response) {
  const parts = []
  for await (const chunk of response.body) parts.push(chunk)
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Read a whole response as parsed JSON.
 * @param {{ status: number, body: AsyncIterable<Uint8Array> }} response - a `send` result.
 * @returns {Promise<{ status: number, body: unknown }>} the status and parsed value, `undefined` when unparsable.
 */
export async function responseJson(response) {
  const { status } = response
  const text = await responseText(response)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status, body: parsed }
}

/**
 * POST a JSON body and buffer the full reply. Used by the short, non-streaming
 * calls (token refresh, profile/model discovery, usage) on the same egress.
 * @param {string} url - absolute HTTPS URL.
 * @param {unknown} body - value serialized as the JSON request body.
 * @param {Record<string,string>} headers - operation-specific headers.
 * @param {string|undefined} proxyUrl - optional proxy egress.
 * @param {AbortSignal} signal - caller cancellation.
 */
export async function postJsonWithHeaders(url, body, headers, proxyUrl, signal) {
  const merged = { 'content-type': JSON_TYPE, accept: JSON_TYPE, ...headers }
  const response = await post({
    url,
    headers: merged,
    body: JSON.stringify(body),
    signal,
    ...egress(proxyUrl),
  })
  return responseJson(response)
}

/**
 * POST JSON with no operation-specific headers.
 * @param {string} url - absolute HTTPS URL.
 * @param {unknown} body - value serialized as the JSON request body.
 * @param {string|undefined} proxyUrl - optional proxy egress.
 * @param {AbortSignal} signal - caller cancellation.
 */
export function postJson(url, body, proxyUrl, signal) {
  const noExtraHeaders = {}
  return postJsonWithHeaders(url, body, noExtraHeaders, proxyUrl, signal)
}

/**
 * POST an OAuth form and parse its small JSON response.
 * @param {string} url - absolute HTTPS URL.
 * @param {URLSearchParams} body - form fields.
 * @param {string|undefined} proxyUrl - optional proxy egress.
 * @param {AbortSignal} signal - caller cancellation.
 */
export async function postForm(url, body, proxyUrl, signal) {
  const response = await post({
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: JSON_TYPE },
    body: body.toString(),
    signal,
    ...egress(proxyUrl),
  })
  return responseJson(response)
}

/**
 * GET a small JSON document, honouring the optional proxy egress.
 * @param {string} url - absolute HTTPS URL.
 * @param {Record<string,string>} headers - request headers.
 * @param {string|undefined} proxyUrl - optional proxy egress.
 * @param {AbortSignal} signal - caller cancellation.
 */
export async function getJson(url, headers, proxyUrl, signal) {
  const response = await get({
    url,
    headers: { accept: JSON_TYPE, ...headers },
    signal,
    ...egress(proxyUrl),
  })
  return responseJson(response)
}
