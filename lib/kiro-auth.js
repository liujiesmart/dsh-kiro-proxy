/**
 * Credentials: read what Kiro IDE/CLI already signed in with, refresh it, and
 * keep an optional plugin-owned multi-account store beside it.
 *
 * Two credential vocabularies meet here. Kiro writes its own spellings into
 * `~/.aws/sso/cache` — `IdC`, `social`, `external_idp` — and each one decides a
 * different refresh endpoint *and* a different upstream request surface. Guessing
 * from the presence of a field would silently pick the wrong one, so the method
 * is normalized once, here, and every consumer routes on the result.
 *
 * The plugin never deletes or rewrites Kiro-owned files. A refreshed Kiro-owned
 * token stays in memory; only the plugin's own store is written.
 *
 * @module dsh-kiro-proxy/auth
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { kiroError } from './kiro-error.js'
import { postForm, postJson } from './kiro-transport.js'

/** 认证凭据缓存根目录（Kiro IDE/CLI 共用）。 */
export const KIRO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache')
/** Kiro token 文件名。 */
const TOKEN_FILE = 'kiro-auth-token.json'
/** 服务端 token 刷新端点（社交登录和导入凭据）。 */
const SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'
/** 凭据未声明 region 时的默认值。 */
export const DEFAULT_REGION = 'us-east-1'
/** Refresh this long before the recorded expiry. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000
/** Methods Kiro's own auth service refreshes from the refresh token alone. */
const SERVICE_METHODS = new Set(['imported', 'google', 'github', 'social'])

/** Every credential shape this plugin can act on. */
export const AUTH_METHODS = ['builder-id', 'idc', 'google', 'github', 'social', 'imported', 'api_key', 'external_idp']

/**
 * Resolve the plugin's own storage directory.
 *
 * `DSH_HOME` is what the Harness itself uses; the `~/.dsh` fallback keeps the
 * plugin usable from a plain `node` process (the self-tests and the login CLI).
 * @returns {string} absolute directory path.
 */
export function storageDirectory() {
  const base = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(base, 'storages', 'kiro-proxy')
}

function text(value) {
  if (typeof value !== 'string') return undefined
  const t = value.trim()
  return t.length > 0 ? t : undefined
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * First present (non-null) value among several spellings of one field.
 * Kiro's own files use camelCase, the OIDC wire and some exporters snake_case.
 * @param {object | undefined} source
 * @param {...string} keys - spellings in order of preference.
 * @returns {unknown}
 */
function field(source, ...keys) {
  if (source === undefined) return undefined
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * Normalize any recorded method into the vocabulary this plugin acts on.
 *
 * Kiro's own spellings are recognized rather than guessed at, because the guess
 * would decide both the refresh endpoint and the request surface: `IdC` is
 * Identity Center (an AWS SSO token, CodeWhisperer surface), not Builder ID.
 * @param {unknown} value - the recorded method, if any.
 * @param {Record<string, unknown>} [source] - the whole credential record, for provenance fallbacks.
 * @returns {string} one of {@link AUTH_METHODS}.
 */
export function normalizeAuthMethod(value, source = {}) {
  if (typeof value === 'string') {
    if (AUTH_METHODS.includes(value)) return value
    const lower = value.trim().toLowerCase()
    if (lower === 'idc') return 'idc'
    if (lower === 'social') return 'social'
    if (lower === 'builderid' || lower === 'builder_id') return 'builder-id'
    if (lower === 'apikey' || lower === 'api-key' || lower === 'api_key') return 'api_key'
    if (lower === 'externalidp' || lower === 'external-idp' || lower === 'external_idp') return 'external_idp'
  }
  // A record that already passed through {@link normalizeCredential} carries the
  // normalized spelling in `method`. Without this arm, re-normalizing such a
  // record would fall through to the provenance guesses below and silently
  // reclassify an `idc` credential as `builder-id` — which picks a different
  // upstream surface and would fail at the first request.
  const already = source.method
  if (typeof already === 'string' && AUTH_METHODS.includes(already)) return already
  const tEndpoint = source.tokenEndpoint ?? source.token_endpoint
  if (tEndpoint !== undefined) return 'external_idp'
  const tType = source.tokenType ?? source.token_type
  if (tType === 'API_KEY') return 'api_key'
  const start = text(source.startUrl ?? source.start_url)
  const hasClientHash = source.clientIdHash !== undefined || source.client_id_hash !== undefined
  if (hasClientHash) {
    return start === undefined || start === 'https://view.awsapps.com/start' ? 'builder-id' : 'idc'
  }
  if (start !== undefined && start !== 'https://view.awsapps.com/start') return 'idc'
  return 'builder-id'
}

/**
 * Assert a CodeWhisperer profile ARN shape.
 *
 * The value ends up in a request body and in a header, so a malformed one is a
 * configuration error worth naming rather than a service error worth debugging.
 * @param {string} value - candidate ARN.
 * @returns {string} the same ARN.
 */
export function assertProfileArn(value) {
  const arn = text(value)
  if (arn === undefined || !/^arn:aws:[a-z-]+:[a-z0-9-]*:[0-9]*:profile\/[A-Za-z0-9._/-]+$/u.test(arn)) {
    throw kiroError(`Kiro profile ARN "${String(value)}" is not a CodeWhisperer profile ARN`, 'INVALID_CREDENTIAL')
  }
  return arn
}

/**
 * Assert an AWS region name.
 * @param {string} value - candidate region.
 * @returns {string} the same region.
 */
export function assertRegion(value) {
  const region = text(value)
  if (region === undefined || !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(region)) {
    throw kiroError(`Kiro region "${String(value)}" is not an AWS region name`, 'INVALID_CREDENTIAL')
  }
  return region
}

/**
 * Normalize one raw credential record into the shape the resolver uses.
 * @param {unknown} value - a parsed JSON credential.
 * @returns {object} the normalized credential.
 */
export function normalizeCredential(value) {
  const source = record(value)
  if (source === undefined) throw kiroError('Kiro credential is not a JSON object', 'INVALID_CREDENTIAL')
  const read = (...keys) => text(field(source, ...keys))
  const expiry = read('expiresAt', 'expires_at', 'expired')
  // `scopes` is an array in Kiro's own cache and a space-joined string elsewhere.
  let scope
  if (Array.isArray(source.scopes)) {
    const granted = []
    for (const item of source.scopes) {
      const name = text(item)
      if (name !== undefined) granted.push(name)
    }
    scope = granted.join(' ')
  } else {
    scope = read('scope', 'scopes')
  }
  const credential = {
    accessToken: read('accessToken', 'access_token'),
    refreshToken: read('refreshToken', 'refresh_token'),
    expiresAt: expiry === undefined ? undefined : Date.parse(expiry),
    method: normalizeAuthMethod(field(source, 'authMethod', 'auth_method'), source),
    region: text(source.region),
    profileArn: read('profileArn', 'profile_arn'),
    clientIdHash: read('clientIdHash', 'client_id_hash'),
    clientId: read('clientId', 'client_id'),
    clientSecret: read('clientSecret', 'client_secret'),
    tokenEndpoint: read('tokenEndpoint', 'token_endpoint'),
    scope,
    startUrl: read('startUrl', 'start_url'),
    // Re-normalizing an already-normalized credential must not wrap it in itself:
    // the deepest record is the one worth persisting, because it keeps the
    // spellings Kiro itself wrote.
    raw: record(source.raw) ?? source,
  }
  if (credential.accessToken === undefined && credential.refreshToken === undefined) {
    throw kiroError('Kiro credential carries neither an access token nor a refresh token', 'INVALID_CREDENTIAL')
  }
  return credential
}

async function readJsonFile(path, what) {
  let value
  try {
    value = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw kiroError(`Kiro ${what} not found at ${path}`, 'MISSING_CREDENTIAL', { cause: error })
    }
    throw kiroError(`Kiro ${what} at ${path} could not be read`, 'INVALID_CREDENTIAL', { cause: error })
  }
  try {
    return JSON.parse(value)
  } catch (error) {
    throw kiroError(`Kiro ${what} at ${path} is not valid JSON`, 'INVALID_CREDENTIAL', { cause: error })
  }
}

/**
 * Read Kiro IDE/CLI's shared token file, if this machine has one.
 * @param {string} [directory] - cache directory override.
 * @returns {Promise<{ credential: object, directory: string } | undefined>}
 */
export async function readKiroCacheCredential(directory = KIRO_CACHE_DIR) {
  let value
  try {
    value = await readJsonFile(path.join(directory, TOKEN_FILE), 'token file')
  } catch (error) {
    if (error?.code === 'MISSING_CREDENTIAL') return undefined
    throw error
  }
  return { credential: normalizeCredential(value), directory }
}

/**
 * Read one device registration file, which a client-id-hash credential needs in
 * order to refresh.
 * @param {string} directory - the cache directory.
 * @param {string} hash - `clientIdHash` from the credential.
 * @returns {Promise<{ clientId: string, clientSecret: string }>}
 */
async function readRegistration(directory, hash) {
  const registration = record(await readJsonFile(path.join(directory, `${hash}.json`), 'device registration'))
  const pair = {
    clientId: text(field(registration, 'clientId', 'client_id')),
    clientSecret: text(field(registration, 'clientSecret', 'client_secret')),
  }
  // Both halves are needed for the OIDC refresh grant; one alone is useless.
  if (pair.clientId !== undefined && pair.clientSecret !== undefined) return pair
  throw kiroError('Kiro device registration is missing its client id or secret', 'INVALID_CREDENTIAL')
}

/** Access tokens resolved during this process, keyed by a digest of the record. */
const tokenCache = new Map()

function cacheKey(credential) {
  return crypto.createHash('sha256')
    .update(`${credential.accessToken ?? ''}\u0000${credential.refreshToken ?? ''}\u0000${credential.region ?? ''}`)
    .digest('hex')
}

/**
 * Forget every in-memory access token, after a login, logout, or account switch.
 */
export function clearTokenCache() {
  tokenCache.clear()
}

function refreshDetail(body, status) {
  const reason = text(field(record(body), 'error_description', 'errorDescription', 'message', 'error'))
  return reason === undefined ? `HTTP ${status}` : reason
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The endpoint is chosen by method, not by what happens to be present: an
 * AWS-issued token refreshes through regional OIDC and needs its device
 * registration, a Kiro-issued one refreshes through Kiro's desktop service from
 * the refresh token alone, and an external IdP token refreshes at its own
 * endpoint with its own client.
 * @param {object} credential - normalized credential.
 * @param {string} directory - directory holding the device registration.
 * @param {string} region - region to record on the refreshed token.
 * @param {string|undefined} proxyUrl - optional proxy egress.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt: number, profileArn?: string }>}
 */
async function refreshCredential(credential, directory, region, proxyUrl, signal) {
  const refreshToken = credential.refreshToken
  if (refreshToken === undefined) {
    throw kiroError('Kiro credential has expired and carries no refresh token', 'INVALID_CREDENTIAL')
  }
  let response
  if (credential.method === 'external_idp') {
    if (credential.clientId === undefined || credential.tokenEndpoint === undefined || credential.scope === undefined) {
      throw kiroError('Kiro external IdP credential is missing client, endpoint, or scopes', 'INVALID_CREDENTIAL')
    }
    response = await postForm(credential.tokenEndpoint, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.clientId,
      refresh_token: refreshToken,
      scope: credential.scope,
    }), proxyUrl, signal)
  } else if (credential.clientIdHash !== undefined) {
    const registration = credential.clientId !== undefined && credential.clientSecret !== undefined
      ? { clientId: credential.clientId, clientSecret: credential.clientSecret }
      : await readRegistration(directory, credential.clientIdHash)
    response = await postJson(`https://oidc.${region}.amazonaws.com/token`, {
      refreshToken,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      grantType: 'refresh_token',
    }, proxyUrl, signal)
  } else if (SERVICE_METHODS.has(credential.method)) {
    response = await postJson(SOCIAL_REFRESH_URL, { refreshToken }, proxyUrl, signal)
  } else {
    throw kiroError(
      `Kiro ${credential.method} credential cannot be refreshed without its client registration; `
      + 'sign in through the Kiro settings page to store a refreshable credential',
      'INVALID_CREDENTIAL',
    )
  }
  if (response.status !== 200) {
    throw kiroError(`Kiro token refresh failed: ${refreshDetail(response.body, response.status)}`, 'AUTH', {
      status: response.status,
    })
  }
  const granted = record(response.body)
  const freshAccess = text(field(granted, 'accessToken', 'access_token'))
  if (freshAccess === undefined) throw kiroError('Kiro token refresh returned no access token', 'AUTH')
  // Refresh tokens may rotate; keep the old one when the server does not send a new one.
  const rotated = text(field(granted, 'refreshToken', 'refresh_token'))
  const seconds = Number(field(granted, 'expiresIn', 'expires_in'))
  const ttlSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600
  const refreshed = {
    accessToken: freshAccess,
    refreshToken: rotated === undefined ? refreshToken : rotated,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  const arn = text(field(granted, 'profileArn', 'profile_arn'))
  if (arn !== undefined) refreshed.profileArn = assertProfileArn(arn)
  return refreshed
}

/**
 * Resolve one usable access token from a credential, refreshing when needed.
 * @param {object} credential - normalized credential.
 * @param {{ directory?: string, region?: string, proxyUrl?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ accessToken: string, region: string, method: string, profileArn?: string, expiresAt: number, refreshed: boolean, credential: object }>}
 */
export async function resolveAccessToken(credential, options = {}) {
  const signal = options.signal ?? new AbortController().signal
  const directory = options.directory ?? KIRO_CACHE_DIR
  const region = assertRegion(options.region ?? credential.region ?? DEFAULT_REGION)
  const key = cacheKey(credential)
  const cached = tokenCache.get(key)
  if (cached !== undefined && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return { ...cached, region, refreshed: false, credential }
  }
  if (credential.method === 'api_key') {
    const token = {
      accessToken: credential.accessToken,
      expiresAt: Number.MAX_SAFE_INTEGER,
      method: credential.method,
      profileArn: credential.profileArn,
    }
    tokenCache.set(key, token)
    return { ...token, region, refreshed: false, credential }
  }
  if (credential.accessToken !== undefined
    && credential.expiresAt !== undefined
    && credential.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    const token = {
      accessToken: credential.accessToken,
      expiresAt: credential.expiresAt,
      method: credential.method,
      profileArn: credential.profileArn,
    }
    tokenCache.set(key, token)
    return { ...token, region, refreshed: false, credential }
  }
  const refreshed = await refreshCredential(credential, directory, region, options.proxyUrl, signal)
  const token = {
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    method: credential.method,
    profileArn: refreshed.profileArn ?? credential.profileArn,
  }
  tokenCache.set(key, token)
  return {
    ...token,
    region,
    refreshed: true,
    credential: {
      ...credential,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
      expiresAt: refreshed.expiresAt,
      profileArn: token.profileArn,
    },
  }
}

/** Accounts file schema version; bumped only on an incompatible shape change. */
const ACCOUNTS_VERSION = 1

/**
 * The plugin-owned multi-account store.
 *
 * Accounts live in one atomic document so that adding, switching, and removing
 * are each a single write: a crash can lose the newest change but never leave a
 * half-written selection.
 */
export class AccountStore {
  /**
   * @param {string} [directory] - storage directory override.
   */
  constructor(directory = storageDirectory()) {
    this.directory = directory
    this.path = path.join(directory, 'accounts.json')
  }

  /**
   * Read the store, tolerating an absent or unreadable file.
   * @returns {Promise<{ version: number, activeId: string | null, accounts: object[] }>}
   */
  async read() {
    try {
      const value = record(await readJsonFile(this.path, 'account store'))
      const accounts = Array.isArray(value?.accounts)
        ? value.accounts.map(record).filter(entry => entry !== undefined)
        : []
      const activeId = text(value?.activeId)
      return {
        version: Number.isInteger(value?.version) ? value.version : ACCOUNTS_VERSION,
        activeId: activeId !== undefined && accounts.some(entry => entry.id === activeId)
          ? activeId
          : accounts[0]?.id ?? null,
        accounts,
      }
    } catch (error) {
      if (error?.code === 'MISSING_CREDENTIAL' || error?.code === 'INVALID_CREDENTIAL') {
        return { version: ACCOUNTS_VERSION, activeId: null, accounts: [] }
      }
      throw error
    }
  }

  /**
   * Write the store atomically with owner-only permissions.
   * @param {{ activeId: string | null, accounts: object[] }} state - the next document.
   */
  async write(state) {
    await fs.mkdir(this.directory, { recursive: true })
    const temporary = `${this.path}.${String(process.pid)}-${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify({
      version: ACCOUNTS_VERSION,
      activeId: state.activeId,
      accounts: state.accounts,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.path)
  }

  /**
   * Add or replace one account and make it active.
   * @param {object} entry - `{ label, credential }`; the credential is normalized here.
   * @param {string} [id] - replace this account instead of adding one.
   * @returns {Promise<object>} the stored account.
   */
  async save(entry, id) {
    const state = await this.read()
    const credential = normalizeCredential(entry.credential)
    const account = {
      id: id ?? crypto.randomUUID(),
      label: text(entry.label) ?? labelFor(credential),
      method: credential.method,
      region: credential.region ?? DEFAULT_REGION,
      profileArn: credential.profileArn,
      credential: credential.raw,
      addedAt: new Date().toISOString(),
    }
    const existing = state.accounts.findIndex(item => item.id === account.id)
    const accounts = existing >= 0
      ? state.accounts.map((item, index) => index === existing ? account : item)
      : [...state.accounts, account]
    await this.write({ activeId: account.id, accounts })
    return account
  }

  /**
   * Remove one account; removing the active one hands the selection to another.
   * @param {string} id - account id.
   * @returns {Promise<boolean>} whether anything was removed.
   */
  async remove(id) {
    const state = await this.read()
    const accounts = state.accounts.filter(item => item.id !== id)
    if (accounts.length === state.accounts.length) return false
    const activeId = state.activeId === id ? accounts[0]?.id ?? null : state.activeId
    await this.write({ activeId, accounts })
    clearTokenCache()
    return true
  }

  /**
   * Make one stored account active.
   * @param {string} id - account id.
   */
  async use(id) {
    const state = await this.read()
    if (!state.accounts.some(item => item.id === id)) {
      throw kiroError(`Kiro account "${id}" is not stored`, 'INVALID_REQUEST')
    }
    await this.write({ activeId: id, accounts: state.accounts })
    clearTokenCache()
  }

  /**
   * Describe every stored account without exposing its tokens.
   * @returns {Promise<{ activeId: string | null, accounts: object[] }>}
   */
  async describe() {
    const state = await this.read()
    return {
      activeId: state.activeId,
      accounts: state.accounts.map(account => {
        let credential
        try {
          credential = normalizeCredential(account.credential)
        } catch {
          return {
            id: account.id,
            label: account.label ?? account.id,
            method: account.method ?? 'unknown',
            region: account.region ?? DEFAULT_REGION,
            state: 'signin',
            active: account.id === state.activeId,
          }
        }
        const usable = credential.method === 'api_key'
          || (credential.accessToken !== undefined
            && credential.expiresAt !== undefined
            && credential.expiresAt - EXPIRY_BUFFER_MS > Date.now())
        return {
          id: account.id,
          label: account.label ?? account.id,
          method: credential.method,
          region: account.region ?? credential.region ?? DEFAULT_REGION,
          profileArn: credential.profileArn,
          state: usable ? 'ready' : credential.refreshToken === undefined ? 'signin' : 'refresh',
          active: account.id === state.activeId,
        }
      }),
    }
  }

  /**
   * Resolve the active stored credential, if any.
   * @returns {Promise<{ credential: object, id: string, label: string } | undefined>}
   */
  async active() {
    const state = await this.read()
    const account = state.accounts.find(item => item.id === state.activeId)
    if (account === undefined) return undefined
    try {
      return { credential: normalizeCredential(account.credential), id: account.id, label: account.label ?? account.id }
    } catch {
      return undefined
    }
  }

  /**
   * Delete the store entirely.
   */
  async clear() {
    await fs.unlink(this.path).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
    clearTokenCache()
  }
}

/**
 * Derive a readable label for a credential, so a stored account is identifiable
 * without the user naming it.
 * @param {object} credential - normalized credential.
 * @returns {string} the label.
 */
function labelFor(credential) {
  const region = credential.region ?? DEFAULT_REGION
  const method = credential.method
  if (method === 'idc') return `IAM Identity Center · ${region}`
  if (method === 'builder-id') return `AWS Builder ID · ${region}`
  if (method === 'api_key') return `Kiro API key · ${region}`
  if (method === 'external_idp') return `External IdP · ${region}`
  if (method === 'google') return `Google · ${region}`
  if (method === 'github') return `GitHub · ${region}`
  if (method === 'social') return `Social sign-in · ${region}`
  return `Imported token · ${region}`
}

/**
 * Pick the credential a request should use, in priority order: the plugin's own
 * store, then Kiro IDE/CLI's shared cache.
 * @param {{ store: AccountStore, cacheDirectory?: string }} options
 * @returns {Promise<{ credential: object, directory: string, source: 'managed'|'kiro-cache', label?: string, accountId?: string }>}
 */
export async function resolveCredential(options) {
  const active = await options.store.active()
  if (active !== undefined) {
    return {
      credential: active.credential,
      directory: options.store.directory,
      source: 'managed',
      label: active.label,
      accountId: active.id,
    }
  }
  const cached = await readKiroCacheCredential(options.cacheDirectory ?? KIRO_CACHE_DIR)
  if (cached !== undefined) {
    return { credential: cached.credential, directory: cached.directory, source: 'kiro-cache', label: 'Kiro IDE/CLI' }
  }
  throw kiroError(
    'No Kiro credential found. Sign in with Kiro IDE/CLI, or import a credential in Settings → Kiro Proxy.',
    'MISSING_CREDENTIAL',
  )
}

/**
 * Import a credential from a pasted JSON document, a bare refresh token, or an
 * API key.
 * @param {{ json?: string, refreshToken?: string, apiKey?: string, label?: string }} input
 * @returns {{ credential: object, label?: string }}
 */
export function importCredential(input) {
  const label = text(input.label)
  if (text(input.apiKey) !== undefined) {
    return {
      credential: normalizeCredential({ accessToken: text(input.apiKey), authMethod: 'api_key', region: DEFAULT_REGION }),
      label: label ?? 'Kiro API key',
    }
  }
  if (text(input.refreshToken) !== undefined) {
    const token = text(input.refreshToken)
    return {
      credential: normalizeCredential({ refreshToken: token, authMethod: 'imported', region: DEFAULT_REGION }),
      label: label ?? 'Imported refresh token',
    }
  }
  const json = text(input.json)
  if (json === undefined) {
    throw kiroError('Provide a credential JSON document, a refresh token, or an API key', 'INVALID_REQUEST')
  }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw kiroError('The pasted credential is not valid JSON', 'INVALID_REQUEST', { cause: error })
  }
  const credential = normalizeCredential(parsed)
  return { credential, label }
}
