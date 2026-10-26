/**
 * In-plugin sign-in for Kiro, covering every method the settings page offers.
 *
 * Three shapes of login live here:
 *
 * - **AWS OIDC device code** (`builder-id`, `idc`): `client/register` →
 *   `device_authorization` → polled `token`. Builder ID and Identity Center are
 *   the same three calls; only the start URL and region differ.
 * - **Kiro social device code** (`google`, `github`): Kiro's own auth service
 *   hands out a code that is approved on `app.kiro.dev`, then polled for tokens.
 * - **Import** (`refresh-token`, `api-key`, `external-idp`): no network exchange
 *   at all — the pasted credential is validated locally and stored as-is.
 *
 * Polling is driven by the settings page rather than by a Host timer: a login
 * nobody is watching should not keep calling AWS, and a plugin reload must not
 * leave an orphaned loop behind. The Host still enforces the server's interval,
 * so a fast-polling page cannot earn a `slow_down` for everyone.
 *
 * @module dsh-kiro-proxy/login
 */

import { randomUUID } from 'node:crypto'
import { kiroError } from './kiro-error.js'
import { DEFAULT_REGION, assertRegion, importCredential, normalizeCredential } from './kiro-auth.js'
import { postJson } from './kiro-transport.js'

/** Builder ID portal; any other start URL names an Identity Center instance. */
export const BUILDER_ID_START_URL = 'https://view.awsapps.com/start'
/**
 * The Identity Center application Kiro itself is registered under.
 *
 * A public client registered without this issuer belongs to no instance, and the
 * portal answers the device code with "We could not verify your sign-in
 * credentials". It is not the user's own start URL — every Kiro sign-in uses
 * this same application.
 */
export const KIRO_ISSUER_URL = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6'
/** Scopes Kiro asks for; the identity token carries exactly these. */
export const KIRO_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
]
/** Kiro's desktop auth service (social sign-in and token refresh). */
const KIRO_AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const SOCIAL_AUTHORIZE_URL = `${KIRO_AUTH_SERVICE}/oauth/device/authorization`
const SOCIAL_POLL_URL = `${KIRO_AUTH_SERVICE}/oauth/device/poll`
/** The client id Kiro's social device flow is registered under. */
const SOCIAL_CLIENT_ID = 'kiro-cli'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** RFC 8628 §3.5: a `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_STEP_S = 5
/** Finished logins are kept briefly so a late poll still sees the outcome. */
const FINISHED_TTL_MS = 2 * 60 * 1000

/** Every method the settings page can start. */
export const LOGIN_METHODS = ['builder-id', 'idc', 'google', 'github', 'refresh-token', 'api-key', 'external-idp']

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Read the OAuth progress marker from a device-flow answer.
 *
 * The OIDC surface answers `{ error }`; the social surface answers `{ status }`
 * or `{ error }` depending on where the flow stopped, so both are read.
 * @param {unknown} body - decoded body.
 * @returns {string | undefined} a code such as `authorization_pending`.
 */
function progressOf(body) {
  const value = record(body)
  const direct = text(value?.error) ?? text(value?.status)
  if (direct !== undefined) return direct
  const type = text(value?.__type) ?? ''
  if (/AuthorizationPending/u.test(type)) return 'authorization_pending'
  if (/SlowDown/u.test(type)) return 'slow_down'
  if (/ExpiredToken/u.test(type)) return 'expired_token'
  if (/AccessDenied/u.test(type)) return 'access_denied'
  return undefined
}

function describeFailure(step, response) {
  const value = record(response.body)
  const reason = text(value?.error_description) ?? text(value?.message) ?? progressOf(response.body)
  return `Kiro ${step} failed: ${reason ?? `HTTP ${response.status}`}`
}

/**
 * Validate an Identity Center start URL (the AWS access portal URL).
 *
 * The value goes to AWS and is later shown as a link, so it must be an absolute
 * HTTPS URL on AWS's own portal host with the `/start` path — the same shape
 * Kiro's client insists on.
 * @param {unknown} value - candidate start URL; empty means Builder ID.
 * @returns {string} the normalized URL.
 */
export function normalizeStartUrl(value) {
  const raw = text(value)
  if (raw === undefined) return BUILDER_ID_START_URL
  let url
  try {
    url = new URL(raw)
  } catch {
    throw kiroError(`"${raw}" is not a valid IAM Identity Center start URL`, 'INVALID_REQUEST')
  }
  const portalHost = url.hostname === 'view.awsapps.com' || url.hostname.endsWith('.awsapps.com')
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !portalHost) {
    throw kiroError(
      'The IAM Identity Center start URL must look like https://<your-org>.awsapps.com/start',
      'INVALID_REQUEST',
    )
  }
  if (url.pathname !== '/start' && url.pathname !== '/start/') {
    throw kiroError('The IAM Identity Center start URL must end with /start', 'INVALID_REQUEST')
  }
  return url.href.replace(/\/+$/u, '')
}

/**
 * Owns in-flight logins.
 */
export class DeviceLogin {
  /**
   * @param {{
   *   post?: (url: string, body: unknown, proxyUrl: string | undefined, signal: AbortSignal) => Promise<{ status: number, body: unknown }>,
   *   now?: () => number,
   *   proxyUrl?: () => string | undefined,
   *   clientName?: string,
   * }} [deps]
   */
  constructor(deps = {}) {
    this.post = deps.post ?? postJson
    this.now = deps.now ?? Date.now
    this.proxyUrl = deps.proxyUrl ?? (() => undefined)
    this.clientName = deps.clientName ?? 'kiro-oauth-client'
    /** Client registrations by issuer; one registration serves many logins. */
    this.registrations = new Map()
    this.sessions = new Map()
  }

  /**
   * Register (or reuse) a public OIDC client for one region.
   *
   * The registration is bound to Kiro's Identity Center application through
   * `issuerUrl`; without it the portal cannot verify the client and refuses the
   * device code, which is why one registration is shared by every sign-in.
   * @param {string} region - OIDC region.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ clientId: string, clientSecret: string, expiresAt?: number }>}
   */
  async register(region, signal = new AbortController().signal) {
    const cached = this.registrations.get(region)
    // Keep a margin: a secret that expires mid-login would fail the token call.
    if (cached !== undefined && (cached.expiresAt === undefined || cached.expiresAt - 10 * 60 * 1000 > this.now())) {
      return cached
    }
    const response = await this.post(`https://oidc.${region}.amazonaws.com/client/register`, {
      clientName: this.clientName,
      clientType: 'public',
      scopes: KIRO_SCOPES,
      grantTypes: [DEVICE_GRANT, 'refresh_token'],
      issuerUrl: KIRO_ISSUER_URL,
    }, this.proxyUrl(), signal)
    if (response.status !== 200) {
      throw kiroError(describeFailure('client registration', response), 'AUTH', { status: response.status })
    }
    const body = record(response.body)
    const clientId = text(body?.clientId)
    const clientSecret = text(body?.clientSecret)
    if (clientId === undefined || clientSecret === undefined) {
      throw kiroError('Kiro client registration returned no client id or secret', 'MALFORMED_RESPONSE')
    }
    const seconds = Number(body?.clientSecretExpiresAt)
    const registration = {
      clientId,
      clientSecret,
      ...Number.isFinite(seconds) && seconds > 0 ? { expiresAt: seconds * 1000 } : {},
    }
    this.registrations.set(region, registration)
    return registration
  }

  /**
   * Begin one login, or store an imported credential outright.
   * @param {{
   *   method?: string, region?: string, startUrl?: string, label?: string,
   *   secret?: string, json?: string, signal?: AbortSignal,
   * }} [options]
   * @returns {Promise<object>} the public view; import methods finish immediately.
   */
  async start(options = {}) {
    const method = text(options.method) ?? 'builder-id'
    if (!LOGIN_METHODS.includes(method)) {
      throw kiroError(`Unsupported Kiro sign-in method "${method}"`, 'INVALID_REQUEST')
    }
    this.prune()
    if (method === 'refresh-token' || method === 'api-key' || method === 'external-idp') {
      return this.importDirect(method, options)
    }
    if (method === 'google' || method === 'github') {
      return this.startSocial(method, options)
    }
    return this.startOidcDevice(method, options)
  }

  /**
   * Store a pasted credential without any exchange.
   * @param {string} method - one of the three import methods.
   * @param {object} options - caller input.
   * @returns {object} a view that is already `success`.
   */
  importDirect(method, options) {
    const label = text(options.label)
    let imported
    if (method === 'api-key') {
      imported = importCredential({ apiKey: text(options.secret), label })
    } else if (method === 'refresh-token') {
      imported = importCredential({ refreshToken: text(options.secret), label })
    } else {
      imported = importCredential({ json: text(options.json) ?? text(options.secret), label })
    }
    // Normalizing here means a malformed paste fails now, while the user is
    // looking at the field, instead of at the first request afterwards.
    normalizeCredential(imported.credential)
    const id = randomUUID()
    this.sessions.set(id, {
      id,
      method,
      state: 'success',
      credential: imported.credential,
      ...imported.label === undefined ? {} : { label: imported.label },
      finishedAt: this.now(),
    })
    return this.view(this.sessions.get(id))
  }

  /**
   * Begin an AWS OIDC device login (Builder ID or Identity Center).
   * @param {'builder-id'|'idc'} method - which portal to open.
   * @param {object} options - caller input.
   * @returns {Promise<object>} the pending view.
   */
  async startOidcDevice(method, options) {
    const signal = options.signal ?? new AbortController().signal
    const startUrl = normalizeStartUrl(method === 'idc' ? options.startUrl : BUILDER_ID_START_URL)
    if (method === 'idc' && text(options.region) === undefined) {
      throw kiroError('IAM Identity Center sign-in needs the instance region', 'INVALID_REQUEST')
    }
    const region = assertRegion(text(options.region) ?? DEFAULT_REGION)
    const registration = await this.register(region, signal)
    const response = await this.post(`https://oidc.${region}.amazonaws.com/device_authorization`, {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      startUrl,
    }, this.proxyUrl(), signal)
    if (response.status !== 200) {
      if (progressOf(response.body) === 'invalid_client') this.registrations.delete(region)
      throw kiroError(describeFailure('device authorization', response), 'AUTH', { status: response.status })
    }
    const body = record(response.body)
    const deviceCode = text(body?.deviceCode)
    const userCode = text(body?.userCode)
    const verificationUri = text(body?.verificationUri)
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw kiroError('Kiro device authorization returned no login code', 'MALFORMED_RESPONSE')
    }
    const interval = Number(body?.interval)
    const expiresIn = Number(body?.expiresIn)
    const now = this.now()
    const session = {
      id: randomUUID(),
      method,
      region,
      startUrl,
      registration,
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: text(body?.verificationUriComplete) ?? verificationUri,
      intervalS: Number.isFinite(interval) && interval > 0 ? interval : 5,
      expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000,
      nextPollAt: now + (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
      state: 'pending',
      label: text(options.label),
    }
    this.sessions.set(session.id, session)
    return this.view(session)
  }

  /**
   * Begin a Kiro social device login (Google or GitHub).
   * @param {'google'|'github'} method - the identity provider.
   * @param {object} options - caller input.
   * @returns {Promise<object>} the pending view.
   */
  async startSocial(method, options) {
    const signal = options.signal ?? new AbortController().signal
    const loginProvider = method === 'google' ? 'Google' : 'Github'
    const response = await this.post(SOCIAL_AUTHORIZE_URL, {
      clientId: SOCIAL_CLIENT_ID,
      loginProvider,
    }, this.proxyUrl(), signal)
    if (response.status !== 200) {
      throw kiroError(describeFailure(`${loginProvider} device authorization`, response), 'AUTH', { status: response.status })
    }
    const body = record(response.body)
    const deviceCode = text(body?.deviceCode)
    const userCode = text(body?.userCode)
    // The social surface returns milliseconds, not seconds.
    const intervalMs = Number(body?.intervalInMilliseconds)
    const expiresMs = Number(body?.expiresInMilliseconds)
    const verificationUriComplete = text(body?.verificationUriComplete)
      ?? `https://app.kiro.dev/account/device?user_code=${encodeURIComponent(userCode ?? '')}&login_provider=${loginProvider}`
    if (deviceCode === undefined || userCode === undefined) {
      throw kiroError('Kiro social sign-in returned no login code', 'MALFORMED_RESPONSE')
    }
    const intervalS = Math.max(1, Math.ceil((Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000) / 1000))
    const now = this.now()
    const session = {
      id: randomUUID(),
      method,
      region: DEFAULT_REGION,
      deviceCode,
      userCode,
      verificationUri: verificationUriComplete,
      verificationUriComplete,
      intervalS,
      expiresAt: now + (Number.isFinite(expiresMs) && expiresMs > 0 ? expiresMs : 300_000),
      nextPollAt: now + intervalS * 1000,
      state: 'pending',
      label: text(options.label),
    }
    this.sessions.set(session.id, session)
    return this.view(session)
  }

  /**
   * Ask the provider for a token once, if the interval allows it.
   * @param {string} id - login id from {@link DeviceLogin.start}.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the public view.
   */
  async poll(id, signal = new AbortController().signal) {
    const session = this.sessions.get(id)
    if (session === undefined) throw kiroError('This sign-in is no longer active; start it again', 'INVALID_REQUEST')
    if (session.state !== 'pending') return this.view(session)
    const now = this.now()
    if (now >= session.expiresAt) {
      return this.finish(session, 'expired', 'The sign-in code expired before it was approved')
    }
    // Polling early is answered locally: the page's timer and the server's
    // interval are allowed to disagree, and only the server's one costs a
    // `slow_down`.
    if (now < session.nextPollAt) return this.view(session)
    session.nextPollAt = now + session.intervalS * 1000

    const social = session.method === 'google' || session.method === 'github'
    const response = social
      ? await this.post(SOCIAL_POLL_URL, {
        clientId: SOCIAL_CLIENT_ID,
        deviceCode: session.deviceCode,
      }, this.proxyUrl(), signal)
      : await this.post(`https://oidc.${session.region}.amazonaws.com/token`, {
        clientId: session.registration.clientId,
        clientSecret: session.registration.clientSecret,
        deviceCode: session.deviceCode,
        grantType: DEVICE_GRANT,
      }, this.proxyUrl(), signal)

    if (response.status === 200) {
      const body = record(response.body)
      const accessToken = text(body?.accessToken)
      if (accessToken === undefined) return this.finish(session, 'error', 'Kiro returned no access token')
      const expiresIn = Number(body?.expiresIn)
      const profileArn = text(body?.profileArn)
      session.credential = {
        accessToken,
        refreshToken: text(body?.refreshToken),
        expiresAt: new Date(this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000).toISOString(),
        // Kiro's own spellings, so the record reads like one its IDE wrote.
        authMethod: social ? session.method : session.method === 'idc' ? 'IdC' : 'builder-id',
        provider: social
          ? session.method === 'google' ? 'Google' : 'Github'
          : session.method === 'idc' ? 'Enterprise' : 'BuilderId',
        region: session.region,
        ...session.startUrl === undefined ? {} : { startUrl: session.startUrl },
        ...session.registration === undefined ? {} : {
          clientId: session.registration.clientId,
          clientSecret: session.registration.clientSecret,
          scopes: KIRO_SCOPES,
        },
        ...profileArn === undefined ? {} : { profileArn },
      }
      return this.finish(session, 'success')
    }

    const code = progressOf(response.body)
    if (code === 'authorization_pending') return this.view(session)
    if (code === 'slow_down') {
      session.intervalS += SLOW_DOWN_STEP_S
      session.nextPollAt = this.now() + session.intervalS * 1000
      return this.view(session)
    }
    if (code === 'expired_token') return this.finish(session, 'expired', 'The sign-in code expired before it was approved')
    if (code === 'access_denied') return this.finish(session, 'denied', 'The sign-in was denied in the browser')
    if (code === 'invalid_client' && session.region !== undefined) this.registrations.delete(session.region)
    return this.finish(session, 'error', describeFailure('token request', response))
  }

  /**
   * Abandon one login.
   * @param {string} id - login id.
   * @returns {boolean} whether a pending login was cancelled.
   */
  cancel(id) {
    const session = this.sessions.get(id)
    if (session === undefined || session.state !== 'pending') return false
    this.finish(session, 'cancelled')
    return true
  }

  /**
   * Hand over a finished login's credential exactly once.
   * @param {string} id - login id.
   * @returns {{ credential: object, label?: string } | undefined}
   */
  take(id) {
    const session = this.sessions.get(id)
    if (session === undefined || session.credential === undefined) return undefined
    const { credential, label } = session
    session.credential = undefined
    return { credential, ...label === undefined ? {} : { label } }
  }

  finish(session, state, error) {
    session.state = state
    session.finishedAt = this.now()
    if (error !== undefined) session.error = error
    session.deviceCode = undefined
    return this.view(session)
  }

  /** Drop logins that ended or expired a while ago. */
  prune() {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      const ended = session.finishedAt !== undefined && now - session.finishedAt > FINISHED_TTL_MS
      const stale = session.state === 'pending' && now > session.expiresAt + FINISHED_TTL_MS
      if (ended || stale) this.sessions.delete(id)
    }
  }

  /**
   * The part of a login that may leave the Host: never the device code, the
   * client secret, or the tokens.
   */
  view(session) {
    return {
      id: session.id,
      method: session.method,
      ...session.region === undefined ? {} : { region: session.region },
      state: session.state,
      ...session.userCode === undefined ? {} : { userCode: session.userCode },
      ...session.verificationUri === undefined ? {} : { verificationUri: session.verificationUri },
      ...session.verificationUriComplete === undefined ? {} : { verificationUriComplete: session.verificationUriComplete },
      ...session.intervalS === undefined ? {} : { interval: session.intervalS },
      ...session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt },
      ...session.error === undefined ? {} : { error: session.error },
    }
  }
}
