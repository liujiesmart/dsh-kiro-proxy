/**
 * One error shape for the whole plugin.
 *
 * The Harness normalizes a thrown adapter error by reading two own data
 * properties off it: `code` and an optional `failure` snapshot. A plain `Error`
 * therefore degrades to `UNKNOWN`, so every failure this plugin raises carries
 * both — the code stays routable (`AUTH`, `RATE_LIMIT`, `QUOTA`, …) and the
 * message survives to the user unchanged.
 *
 * @module dsh-kiro-proxy/kiro-error
 */

/**
 * Build a Kiro failure.
 * @param {string} message - human-readable diagnosis.
 * @param {string} code - stable machine-routable class.
 * @param {{ status?: number, cause?: unknown, requestId?: string, retryAfterMs?: number }} [extra]
 *   optional wire facts; `status` must be a real HTTP status when present.
 * @returns {Error} an error carrying own `code` and `failure` properties.
 */
export function kiroError(message, code, extra = {}) {
  const error = new Error(message, extra.cause === undefined ? undefined : { cause: extra.cause })
  error.name = 'KiroError'
  const status = Number.isInteger(extra.status) && extra.status >= 100 && extra.status <= 599
    ? extra.status
    : undefined
  const requestId = typeof extra.requestId === 'string' && extra.requestId.length > 0
    ? extra.requestId
    : undefined
  const retryAfterMs = Number.isFinite(extra.retryAfterMs) && extra.retryAfterMs > 0
    ? extra.retryAfterMs
    : undefined
  const failure = Object.freeze({
    message,
    code,
    ...status === undefined ? {} : { status },
    ...requestId === undefined ? {} : { requestId },
    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
  })
  Object.defineProperty(error, 'code', { value: code, enumerable: false, configurable: true, writable: true })
  Object.defineProperty(error, 'failure', { value: failure, enumerable: false, configurable: true })
  return error
}

/**
 * Narrow an unknown thrown value to its routable code.
 * @param {unknown} value - anything caught.
 * @returns {string} the code, or `UNKNOWN`.
 */
export function errorCode(value) {
  if (typeof value === 'object' && value !== null) {
    const code = /** @type {{ code?: unknown }} */ (value).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'UNKNOWN'
}

/**
 * Render an unknown thrown value as one line for a log or a settings page.
 * @param {unknown} value - anything caught.
 * @returns {string} the message.
 */
export function errorText(value) {
  if (value instanceof Error) return value.message
  return typeof value === 'string' ? value : 'Kiro request failed'
}
