/**
 * The Kiro client: one place that knows how to talk to CodeWhisperer.
 *
 * Everything above this module (the Harness adapter, the OpenAI/Anthropic
 * reverse proxy, the settings page) asks the same four questions — which models
 * does this account have, what does it cost, which profile ARN applies, and
 * what happens when I send a conversation — so the wire facts live here once
 * instead of three times.
 *
 * Kiro has no separate system slot, no `inferenceConfig`, and answers in
 * `vnd.amazon.eventstream` frames rather than JSON or SSE. Those are the three
 * shapes this module absorbs.
 *
 * @module dsh-kiro-proxy/client
 */

import { randomUUID } from 'node:crypto'
import { kiroError } from './kiro-error.js'
import { AccountStore, DEFAULT_REGION, assertProfileArn, assertRegion, resolveAccessToken, resolveCredential } from './kiro-auth.js'
import { getJson, post, postJsonWithHeaders, responseText } from './kiro-transport.js'
import { decodeFrames } from './kiro-eventstream.js'
import { serializeRequest } from './kiro-serialize.js'

/** SDK version string paired with the IDE marker; access to models depends on both. */
const SDK_VERSION = '3.738.0'
const KIRO_USER_AGENT = ['aws-sdk-js/' + SDK_VERSION, 'KiroIDE'].join(' ')
/** Streaming service + operation pair named by the `x-amz-target` header. */
const STREAMING_SERVICE = 'AmazonCodeWhispererStreamingService'
const CODEWHISPERER_TARGET = `${STREAMING_SERVICE}.${'GenerateAssistantResponse'}`
/** Models per ListAvailableModels page; the service caps a page at its own maximum. */
const PAGE_SIZE = 50
/** Pages followed before giving up on a continuation token. */
const MAX_PAGES = 10
/**
 * 空响应时默认换用的模型。
 *
 * 实测同一份提示词：`claude-opus-5.5` / `claude-sonnet-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra`
 * / `claude-opus-5` 只回一个 contextUsageEvent（静默拒答，零内容帧），而
 * `claude-sonnet-4.5` / `glm-5` / `deepseek-3.2` / `minimax-m2.5` / `claude-opus-4.7` 正常作答。
 * 所以空响应时按这张表换模型重试一次，而不是让整轮失败。
 */
const DEFAULT_FALLBACK_MODELS = [
  'claude-sonnet-4.5',
  'claude-opus-4.7',
  'claude-sonnet-4.6',
  'glm-5',
  'deepseek-3.2',
  'minimax-m2.5',
  'claude-haiku-4.5',
]

/** How long a discovered catalog or usage reading stays fresh. */
const CACHE_TTL_MS = 5 * 60 * 1000
/** A failed profile lookup is retried after this long, not on every request. */
const PROFILE_MISS_TTL_MS = 60 * 1000
/** AWS SSO token methods whose refresh never returns a profile ARN. */
const DISCOVERING_METHODS = new Set(['idc', 'external_idp'])
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u
/**
 * Kiro's overload wording, seen verbatim as an in-band exception frame and as a
 * 429 body. Matching the text is unavoidable: the service sends it with a
 * generic type on some surfaces, so a pure status-code classifier misses them.
 */
const OVERLOAD_PATTERN = /unexpectedly high load|throttl|too many requests|slow down|try again|service unavailable/iu
/** Header Kiro's own client reads to know how long to back off. */
const RETRY_AFTER_HEADERS = ['x-amzn-kiro-ratelimit-retry-after', 'retry-after', 'x-amz-retry-after']

/**
 * Read the server's own back-off hint.
 * @param {Record<string, unknown>} headers - response headers.
 * @returns {number | undefined} milliseconds to wait, when the server named one.
 */
function retryAfterMs(headers) {
  for (const name of RETRY_AFTER_HEADERS) {
    const raw = headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string' || value.length === 0) continue
    const seconds = Number(value)
    // The header is documented as seconds; a value that large is already
    // milliseconds from a proxy that rewrote it, so keep the smaller reading.
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.round(seconds * 1000), 60_000)
  }
  return undefined
}

/**
 * Decide whether a failure is worth repeating.
 * @param {{ code?: string, status?: number, message?: string }} failure - classified failure.
 * @returns {boolean} true when the same request may succeed shortly.
 */
function isTransient(failure) {
  if (failure.code === 'RATE_LIMIT' || failure.code === 'SERVER' || failure.code === 'TRANSPORT') return true
  if (failure.status === 429 || failure.status === 503 || failure.status === 502) return true
  return typeof failure.message === 'string' && OVERLOAD_PATTERN.test(failure.message)
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInteger(value) {
  if (typeof value !== 'number') return undefined
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Build the endpoint for one operation.
 *
 * Identity Center and external-IdP tokens are AWS SSO tokens: the `kiro.dev`
 * gateway rejects them, so they must reach the CodeWhisperer surface. Every
 * other method reaches Amazon Q. Both are regional, and the region must be the
 * one the token was minted in.
 * @param {'chat'|'catalog'|'usage'} operation - which surface to address.
 * @param {string} region - AWS region.
 * @param {string} method - normalized auth method.
 * @returns {string} the absolute URL without a query string.
 */
export function kiroEndpoint(operation, region, method) {
  const codewhisperer = method === 'idc' || method === 'external_idp'
  const host = codewhisperer ? `codewhisperer.${region}.amazonaws.com` : `q.${region}.amazonaws.com`
  if (operation === 'chat') return `https://${host}/generateAssistantResponse`
  if (operation === 'catalog') return `https://${host}/ListAvailableModels`
  return `https://${host}/getUsageLimits`
}

/**
 * Ordered request surfaces for one credential.
 *
 * Kiro exposes the same operation on two data planes — Amazon Q (`q.<region>`)
 * and CodeWhisperer (`codewhisperer.<region>`) — and they fail independently:
 * "Encountered unexpectedly high load" is per-surface, so a throttled `q`
 * frequently answers fine on `codewhisperer`, so the client walks this list
 * instead of giving up on the first refusal.
 *
 * The auth method decides the order, not the failure: an AWS SSO token is
 * rejected by the wrong plane with 401/403 (which falls through), while the
 * right plane is the one that can actually serve it.
 * @param {string} region - token region.
 * @param {string} method - normalized auth method.
 * @param {'chat'|'catalog'|'usage'} [operation] - which operation to address.
 * @returns {string[]} candidate URLs, preferred first.
 */
export function kiroEndpointCandidates(region, method, operation = 'chat') {
  // 数据面与 token 的"归属"是两件事：token 只能被自己的面接受，但两个面都可能
  // 独立过载。所以顺序由 authMethod 决定，退避时再换面。
  const primary = method === 'idc' || method === 'external_idp' ? 'codewhisperer' : 'q'
  const secondary = primary === 'codewhisperer' ? 'q' : 'codewhisperer'
  const paths = { chat: 'generateAssistantResponse', catalog: 'ListAvailableModels', usage: 'getUsageLimits' }
  return [primary, secondary].map(plane => `https://${plane}.${region}.amazonaws.com/${paths[operation] ?? paths.chat}`)
}

/**
 * Add the token discriminator two auth methods require.
 * @param {string} method - normalized auth method.
 * @returns {Record<string,string>} extra headers.
 */
function tokenTypeHeaders(method) {
  if (method === 'api_key') return { TokenType: 'API_KEY' }
  if (method === 'external_idp') return { TokenType: 'EXTERNAL_IDP' }
  return {}
}

/**
 * Headers every Kiro request shares.
 *
 * `user-agent` is a protocol constant rather than attribution: Kiro authorizes
 * by client identity and refuses a request whose agent does not name its IDE
 * with "Your subscription does not support this application".
 * @param {object} token - resolved token.
 * @param {object} [extra] - operation-specific headers.
 * @returns {Record<string,string>} the headers.
 */
export function kiroHeaders(token, extra = {}) {
  const headers = {
    authorization: 'Bearer ' + token.accessToken,
    'user-agent': KIRO_USER_AGENT,
    'x-amz-user-agent': KIRO_USER_AGENT,
    'x-amzn-codewhisperer-optout': 'true',
    'x-amzn-codewhisperer-machine-id': 'kiro-desktop',
  }
  Object.assign(headers, tokenTypeHeaders(token.method))
  if (token.profileArn !== undefined) headers['x-amzn-codewhisperer-profile-arn'] = token.profileArn
  return Object.assign(headers, extra)
}

/**
 * Parse the two effort-schema branches Kiro publishes per model.
 * @param {unknown} schema - `additionalModelRequestFieldsSchema`.
 * @returns {{ schemaPath: string, levels: string[], defaultLevel?: string } | undefined}
 */
export function parseEffortSchema(schema) {
  const properties = record(record(schema)?.properties)
  for (const schemaPath of ['output_config', 'reasoning']) {
    const effort = record(record(record(properties?.[schemaPath])?.properties)?.effort)
    const raw = effort?.enum
    if (!Array.isArray(raw)) continue
    const levels = [...new Set(raw.filter(level => typeof level === 'string' && level.length > 0))]
    if (levels.length === 0) continue
    const defaultLevel = typeof effort.default === 'string' && levels.includes(effort.default) ? effort.default : undefined
    return { schemaPath, levels, ...defaultLevel === undefined ? {} : { defaultLevel } }
  }
  return undefined
}

/**
 * Read the bounds of a model's advertised `max_tokens` field.
 * @param {unknown} schema - `additionalModelRequestFieldsSchema`.
 * @returns {{ minimum: number, maximum: number } | undefined}
 */
export function parseMaxTokensBounds(schema) {
  // Walk schema.properties.max_tokens; any missing level means "not advertised".
  let node = record(schema)
  for (const step of ['properties', 'max_tokens']) {
    if (node === undefined) return undefined
    node = record(node[step])
  }
  if (node?.type !== 'integer') return undefined
  const upper = positiveInteger(node.maximum)
  const lower = positiveInteger(node.minimum)
  if (upper === undefined) return undefined
  // An absent minimum means the service accepts anything from 1 upward.
  const bounds = { minimum: lower === undefined ? 1 : lower, maximum: upper }
  if (bounds.minimum > bounds.maximum) return undefined
  return bounds
}

/**
 * Read the input modalities a catalog entry declares.
 * @param {unknown} value - `supportedInputTypes`.
 * @returns {string[] | undefined} declared modalities in display order.
 */
export function parseInputModalities(value) {
  if (!Array.isArray(value)) return undefined
  const advertised = value.flatMap(entry => (typeof entry === 'string' ? [entry.trim().toLowerCase()] : []))
  // Display order is fixed (text before image), regardless of the catalog's order.
  const supported = []
  if (advertised.includes('text')) supported.push('text')
  if (advertised.includes('image')) supported.push('image')
  return supported.length > 0 ? supported : undefined
}

/**
 * Parse one ListAvailableModels page into catalog entries.
 * @param {unknown} body - decoded response.
 * @returns {object[]} the page's models.
 */
export function parseModelPage(body) {
  const raw = record(body)?.models
  if (!Array.isArray(raw)) throw kiroError('Kiro ListAvailableModels returned no models array', 'MALFORMED_RESPONSE')
  const models = []
  const seen = new Set()
  for (const entry of raw) {
    const model = record(entry)
    const id = text(model?.modelId)
    if (model === undefined || id === undefined || seen.has(id)) continue
    seen.add(id)
    const limits = record(model.tokenLimits)
    const fieldsSchema = model.additionalModelRequestFieldsSchema
    const effortInfo = parseEffortSchema(fieldsSchema)
    const bounds = parseMaxTokensBounds(fieldsSchema)
    const hasSchema = Object.hasOwn(model, 'additionalModelRequestFieldsSchema')
    // Insertion order of optional keys is kept stable for serialized output.
    const entryOut = { id, name: text(model.modelName) ?? id }
    const description = text(model.description)
    if (description !== undefined) entryOut.description = description
    const inputCap = positiveInteger(limits === undefined ? undefined : limits.maxInputTokens)
    if (inputCap !== undefined) entryOut.contextWindow = inputCap
    const outputCap = positiveInteger(limits === undefined ? undefined : limits.maxOutputTokens)
    if (outputCap !== undefined) entryOut.maxTokens = outputCap
    const modalities = parseInputModalities(model.supportedInputTypes)
    if (modalities !== undefined) entryOut.inputModalities = modalities
    if (effortInfo !== undefined) {
      entryOut.reasoningEfforts = effortInfo.levels
      entryOut.defaultReasoningEffort = effortInfo.defaultLevel
      entryOut.effortSchemaPath = effortInfo.schemaPath
    }
    if (bounds !== undefined) entryOut.maxTokensBounds = bounds
    // A model that publishes no schema refuses `additionalModelRequestFields`
    // outright, so "has a schema" — not a name heuristic — decides whether
    // effort controls exist for it.
    entryOut.supportsEffort = hasSchema && effortInfo !== undefined
    models.push(entryOut)
  }
  return models
}

/**
 * Map an HTTP status onto a routable failure class.
 * @param {number} status - HTTP status.
 * @param {unknown} body - decoded error body, when available.
 * @param {string} [fallback] - message to use when the body says nothing.
 * @returns {Error} the failure.
 */
export function statusError(status, body, fallback, requestId, retryAfter) {
  const value = record(body)
  const message = text(value?.message) ?? text(value?.Message) ?? fallback ?? `Kiro request failed (HTTP ${status})`
  const reason = text(value?.reason) ?? text(value?.['__type'])
  const detail = `${message} ${reason ?? ''}`
  let code = status === 401 ? 'AUTH'
    : status === 403 ? 'FORBIDDEN'
      : status === 429 ? 'RATE_LIMIT'
        : status === 402 ? 'QUOTA'
          : status >= 500 ? 'SERVER'
            : 'INVALID_REQUEST'
  // An exhausted allowance arrives as 402, and sometimes as a 403 or a throttle
  // whose reason names the monthly/daily cap. Retrying cannot help, so it must
  // not read as a rate limit or a permission problem.
  if (/MONTHLY_REQUEST_COUNT|CREDIT_CONSUMPTION_RATE_EXCEEDED|limit exceeded for this month/iu.test(detail)) {
    code = 'QUOTA'
  }
  // An oversized request is the one 400 the Harness can repair by compacting,
  // so it carries the canonical code instead of the generic one.
  if (status === 400 && /CONTENT_LENGTH_EXCEEDS_THRESHOLD|Input is too long|Prompt is too long/iu.test(detail)) {
    code = 'CONTEXT_WINDOW_EXCEEDED'
  }
  return kiroError(message, code, {
    status,
    ...typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {},
    // 把服务端的退避提示一路带到 Harness，让外层的重试也等对时间。
    ...Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter } : {},
  })
}

/**
 * Decide the stop reason for a stream that ended without a `metadataEvent`.
 *
 * Kiro does not promise that frame. Measured on an ordinary answer, the stream
 * ends with `assistantResponseEvent … , contextUsageEvent, meteringEvent` and no
 * metadata at all — on a *complete* reply. So "visible text but no terminal
 * frame" cannot mean truncation: treating it that way failed every answer, and
 * because the failure is retryable every turn was re-sent until it gave up.
 *
 * What the service does send before closing is its accounting pair
 * (`contextUsageEvent` and/or `meteringEvent`). A stream that stops without them
 * is the one worth suspecting, and a stream whose bytes end mid-frame is caught
 * earlier by the frame decoder, which throws `STREAM_CLOSED`.
 *
 * @param {{ sawTool: boolean, openToolCount: number, visibleCharacters: number, sawTerminalUsage?: boolean }} facts
 *   what the stream produced.
 * @returns {string} a stop reason for the caller's finish mapping.
 */
export function deriveStopReason(facts) {
  if (facts.sawTool || facts.openToolCount > 0) return 'TOOL_USE'
  // The accounting pair is Kiro's own "this answer is over" marker.
  if (facts.sawTerminalUsage === true) return 'END_TURN'
  return facts.visibleCharacters > 0 ? 'STREAM_CLOSED' : 'END_TURN'
}

/**
 * Parse a wire event payload into the plugin's normalized event vocabulary.
 * @param {string} eventType - `:event-type` or `:exception-type` header value.
 * @param {unknown} payload - decoded JSON payload.
 * @returns {object | undefined} the normalized event.
 */
export function normalizeWireEvent(eventType, payload) {
  const value = record(payload)
  if (eventType === 'assistantResponseEvent') {
    const content = typeof value?.content === 'string' ? value.content : ''
    return content.length === 0 ? undefined : { kind: 'text', text: content }
  }
  if (eventType === 'reasoningContentEvent') {
    const content = typeof value?.text === 'string' ? value.text : ''
    return content.length === 0 ? undefined : { kind: 'reasoning', text: content }
  }
  if (eventType === 'toolUseEvent') {
    const id = text(value?.toolUseId)
    if (id === undefined) return undefined
    const name = text(value?.name)
    // input 既可能是增量片段（字符串），也可能是整块对象；两种都要能落到参数里。
    const rawInput = value?.input
    const input = typeof rawInput === 'string'
      ? rawInput
      : rawInput !== undefined && rawInput !== null && typeof rawInput === 'object'
        ? JSON.stringify(rawInput)
        : ''
    if (value?.stop === true) return { kind: 'tool-stop', id }
    // 一次工具调用的帧序列是：
    //   {name, id}                       <- 开始
    //   {input: "", name, id}            <- 空片段（实测真的会发！）
    //   {input: "<片段>", name, id} …    <- 参数增量
    //   {name, stop: true, id}           <- 结束
    // 带 name 的空 input 帧**不是**第二个"开始"，把它当开始会让同一个 id 产出
    // 两个工具块（一个空参数、一个真参数），而服务端下一步会因此 400。
    // 空 input 帧（实测每轮工具调用都会先发一帧）只是"参数还没开始"，语义上仍属于
    // 同一个调用的开始；adapter 端按 id 幂等，所以这里统一成 tool-start。
    if (input.length === 0) {
      return name === undefined ? undefined : { kind: 'tool-start', id, name }
    }
    return { kind: 'tool-delta', id, name, argumentsDelta: input }
  }
  if (eventType === 'contextUsageEvent') {
    const percentage = Number(value?.contextUsagePercentage)
    return Number.isFinite(percentage) ? { kind: 'context-usage', percentage } : undefined
  }
  if (eventType === 'meteringEvent') {
    const usage = Number(value?.usage)
    return Number.isFinite(usage) ? { kind: 'metering', usage, unit: text(value?.unit) ?? 'credit' } : undefined
  }
  if (eventType === 'metadataEvent') {
    const tokenUsage = record(value?.tokenUsage)
    const usage = tokenUsage === undefined ? undefined : {
      inputTokens: Number(tokenUsage.uncachedInputTokens ?? 0),
      outputTokens: Number(tokenUsage.outputTokens ?? 0),
      cacheReadTokens: Number(tokenUsage.cacheReadInputTokens ?? 0),
      cacheWriteTokens: Number(tokenUsage.cacheWriteInputTokens ?? 0),
      totalTokens: positiveInteger(tokenUsage.totalTokens),
      contextPercentage: Number.isFinite(Number(tokenUsage.contextUsagePercentage))
        ? Number(tokenUsage.contextUsagePercentage)
        : undefined,
    }
    return {
      kind: 'metadata',
      stopReason: text(value?.stopReason) ?? 'END_TURN',
      ...usage === undefined ? {} : { usage },
    }
  }
  return undefined
}

/**
 * The client shared by the Harness adapter and the reverse proxy.
 */
export class KiroClient {
  /**
   * @param {{ store?: AccountStore, cacheDirectory?: string, options?: () => object }} [deps]
   *   `options()` returns the live connection facts, so a settings change is
   *   picked up by the next request without re-registering anything.
   */
  constructor(deps = {}) {
    this.store = deps.store ?? new AccountStore()
    this.cacheDirectory = deps.cacheDirectory
    this.options = deps.options ?? (() => ({}))
    // 传输与时钟可注入，重试逻辑才能在离线测试里被验证。
    this.post = deps.post ?? post
    this.postJson = deps.postJson ?? postJsonWithHeaders
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    // 并发闸门：Kiro 按账号限流，把请求一次性全打出去只会自己造出
    // 「unexpectedly high load」。默认同时 2 条，其余排队。
    this.inflight = 0
    this.waiters = []
    // 每个 (region, method) 最近一次成功的 surface：省掉每次的试错往返。
    this.surfacePreference = new Map()
    this.catalogCache = new Map()
    this.usageCache = new Map()
    this.profileCache = new Map()
  }

  /** Current connection facts, with defaults applied. */
  connection() {
    const raw = this.options() ?? {}
    return {
      proxyUrl: text(raw.proxyUrl),
      region: text(raw.region),
      profileArn: text(raw.profileArn),
      maxContextWindow: positiveInteger(raw.maxContextWindow),
      enabledModels: Array.isArray(raw.enabledModels) ? raw.enabledModels.filter(id => typeof id === 'string') : undefined,
      // 并发与重试次数必须一起透出：它们决定「一次请求打出去几次」，
      // 收敛在这里而不是各自读 options()，重试与闸门才看到同一个值。
      maxRequestChars: positiveInteger(raw.maxRequestChars),
      maxConcurrency: positiveInteger(raw.maxConcurrency),
      retryAttempts: positiveInteger(raw.retryAttempts),
      // 空响应时是否换模型，以及换哪些（字符串数组，顺序即优先级）。
      fallbackOnEmpty: raw.fallbackOnEmpty === false ? false : undefined,
      autoContinue: raw.autoContinue === false ? false : undefined,
      maxContinuations: positiveInteger(raw.maxContinuations),
      fallbackModels: Array.isArray(raw.fallbackModels)
        ? raw.fallbackModels.filter(id => typeof id === 'string' && id.length > 0)
        : undefined,
    }
  }

  /**
   * Resolve the credential and a usable token for one request.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<{ token: object, credential: object, source: string, label?: string }>}
   */
  async authenticate(signal = new AbortController().signal) {
    const connection = this.connection()
    const resolved = await resolveCredential({ store: this.store, cacheDirectory: this.cacheDirectory })
    const token = await resolveAccessToken(resolved.credential, {
      directory: resolved.directory,
      region: connection.region ?? resolved.credential.region,
      proxyUrl: connection.proxyUrl,
      signal,
    })
    let profileArn = connection.profileArn != null ? connection.profileArn : token.profileArn
    let region = assertRegion(token.region ?? DEFAULT_REGION)
    // An Identity Center token comes back from OIDC without a profile ARN, and
    // the service refuses an IdC request that names none (403 AccessDenied).
    // Its credential region is also the Identity Center instance's region, which
    // is not necessarily a region Kiro serves; the profile ARN names the one it
    // does. So discover the ARN and let it decide the API region.
    if (profileArn == null && DISCOVERING_METHODS.has(token.method)) {
      profileArn = await this.discoverProfileArn({ ...token, region }, connection.region ?? region, signal)
    }
    if (profileArn != null && connection.region == null) {
      const arnRegion = String(profileArn).split(':')[3]
      if (REGION_PATTERN.test(arnRegion ?? '')) region = arnRegion
    }
    return {
      token: {
        ...token,
        region,
        ...profileArn == null ? {} : { profileArn: assertProfileArn(profileArn) },
      },
      credential: resolved.credential,
      source: resolved.source,
      ...resolved.label === undefined ? {} : { label: resolved.label },
    }
  }

  /**
   * Discover the account's CodeWhisperer profile ARN, when the credential has none.
   * @param {object} token - resolved token.
   * @param {string} region - region to ask.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<string | undefined>} the best profile ARN.
   */
  async discoverProfileArn(token, region, signal = new AbortController().signal) {
    if (token.method === 'api_key') return undefined
    const key = `${region}\u0000${token.accessToken}`
    const cached = this.profileCache.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.profileArn
    // Kiro profiles live in the regions Kiro serves (us-east-1, eu-central-1),
    // which an Identity Center instance region often is not; ask those too.
    const candidates = [...new Set([region, token.region, DEFAULT_REGION, 'eu-central-1'].filter(Boolean))]
    const { proxyUrl } = this.connection()
    const targetHeaders = {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles',
    }
    for (const candidate of candidates) {
      // CodeWhisperer is the plane that answers AWS SSO tokens, so it goes first;
      // the q plane and the JSON-RPC form cover accounts provisioned on the other.
      const attempts = [
        { url: `https://codewhisperer.${candidate}.amazonaws.com/ListAvailableProfiles`, headers: {} },
        { url: `https://q.${candidate}.amazonaws.com/ListAvailableProfiles`, headers: {} },
        { url: `https://codewhisperer.${candidate}.amazonaws.com`, headers: targetHeaders },
      ]
      for (const attempt of attempts) {
        let response
        try {
          response = await this.postJson(
            attempt.url,
            { maxResults: 50 },
            kiroHeaders(token, attempt.headers),
            proxyUrl,
            signal,
          )
        } catch (error) {
          if (signal.aborted) throw error
          continue
        }
        if (response.status !== 200) continue
        const bodyRec = record(response.body)
        const profiles = bodyRec !== undefined ? bodyRec.profiles : undefined
        if (!Array.isArray(profiles)) continue
        const valid = []
        for (const entry of profiles) {
          const arn = text(record(entry)?.arn ?? record(entry)?.profileArn)
          if (arn === undefined) continue
          try {
            valid.push(assertProfileArn(arn))
          } catch {
            // A malformed upstream entry must not reach a header.
          }
        }
        const tokenRegion = token.region
        const regional = valid.find(arn => arn.split(':')[3] === tokenRegion)
        const chosen = regional != null ? regional : valid[0]
        if (chosen !== undefined) {
          this.profileCache.set(key, { profileArn: chosen, expiresAt: Date.now() + CACHE_TTL_MS })
          return chosen
        }
      }
    }
    // Remember the miss briefly: an IdC account asks on every authenticate().
    this.profileCache.set(key, { profileArn: undefined, expiresAt: Date.now() + PROFILE_MISS_TTL_MS })
    return undefined
  }

  /**
   * List the models this account may route to.
   * @param {AbortSignal} signal - caller cancellation.
   * @param {boolean} [force] - bypass a still-valid cache entry.
   * @returns {Promise<object[]>} catalog entries.
   */
  async models(signal = new AbortController().signal, force = false) {
    const connection = this.connection()
    const { token } = await this.authenticate(signal)
    const authRegion = connection.region != null ? connection.region : token.region
    // Only ask the service when the credential carries no ARN of its own.
    const profileArn = token.profileArn != null
      ? token.profileArn
      : await this.discoverProfileArn(token, authRegion, signal)
    const profileRegion = profileArn != null ? profileArn.split(':')[3] : undefined
    const region = profileRegion !== undefined && /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(profileRegion)
      ? profileRegion
      : authRegion
    const arnPart = profileArn != null ? profileArn : ''
    const proxyPart = connection.proxyUrl != null ? connection.proxyUrl : ''
    const key = `${region}\u0000${arnPart}\u0000${proxyPart}`
    const cached = this.catalogCache.get(key)
    const now = Date.now()
    if (!force && cached !== undefined && cached.expiresAt > now) return cached.models

    const url = new URL(kiroEndpoint('catalog', region, token.method))
    url.searchParams.set('origin', 'AI_EDITOR')
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (profileArn !== undefined) url.searchParams.set('profileArn', profileArn)

    const models = []
    const seen = new Set()
    const usedTokens = new Set()
    let nextToken
    let page = 0
    while (page < MAX_PAGES) {
      if (nextToken === undefined) url.searchParams.delete('nextToken')
      else url.searchParams.set('nextToken', nextToken)
      const response = await getJson(url.toString(), kiroHeaders(token), connection.proxyUrl, signal)
      if (response.status !== 200) {
        if (models.length === 0) {
          throw statusError(response.status, response.body, `Kiro model discovery failed (HTTP ${response.status})`)
        }
        break
      }
      let added = 0
      for (const model of parseModelPage(response.body)) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
        added += 1
      }
      const token2 = text(record(response.body)?.nextToken)
      // The live endpoint returns an empty token on every page, so a repeated
      // token and a page that added nothing are both stop conditions; walking
      // on either would loop forever.
      if (token2 === undefined || usedTokens.has(token2) || (page > 0 && added === 0)) break
      usedTokens.add(token2)
      nextToken = token2
      page += 1
    }
    if (models.length === 0) throw kiroError('Kiro returned no usable model ids', 'MALFORMED_RESPONSE')
    this.catalogCache.set(key, { models, expiresAt: Date.now() + CACHE_TTL_MS })
    return models
  }

  /**
   * Read the account's plan and credit usage.
   * @param {AbortSignal} signal - caller cancellation.
   * @param {boolean} [force] - bypass a still-valid cache entry.
   * @returns {Promise<object>} the usage snapshot.
   */
  async usage(signal = new AbortController().signal, force = false) {
    const connection = this.connection()
    const { token } = await this.authenticate(signal)
    const region = connection.region != null ? connection.region : token.region
    const profileArn = token.profileArn
    const arnPart = profileArn != null ? profileArn : ''
    const proxyPart = connection.proxyUrl != null ? connection.proxyUrl : ''
    const key = `${region}\u0000${arnPart}\u0000${proxyPart}`
    const cached = this.usageCache.get(key)
    const now = Date.now()
    if (!force && cached !== undefined && cached.expiresAt > now) return cached.usage

    const query = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' })
    if (profileArn !== undefined) query.set('profileArn', profileArn)
    const idcUsageUrl = kiroEndpoint('usage', region, 'idc')
    const tokenUsageUrl = kiroEndpoint('usage', region, token.method)
    const postUrl = idcUsageUrl.replace(/\/getUsageLimits$/u, '')
    const postBody = { origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' }
    if (profileArn !== undefined) postBody.profileArn = profileArn
    const postHeaders = {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits',
    }
    const attempts = [
      () => getJson(`${idcUsageUrl}?${query.toString()}`, kiroHeaders(token), connection.proxyUrl, signal),
      () => postJsonWithHeaders(postUrl, postBody, kiroHeaders(token, postHeaders), connection.proxyUrl, signal),
      () => getJson(`${tokenUsageUrl}?${query.toString()}`, kiroHeaders(token), connection.proxyUrl, signal),
    ]
    let lastStatus = 0
    let lastError
    for (const attempt of attempts) {
      try {
        const response = await attempt()
        lastStatus = response.status
        if (response.status !== 200) continue
        const usage = parseUsage(response.body)
        this.usageCache.set(key, { usage, expiresAt: Date.now() + CACHE_TTL_MS })
        return usage
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
      }
    }
    const message = lastStatus > 0 ? `Kiro usage is temporarily unavailable (HTTP ${lastStatus})` : 'Kiro usage is temporarily unavailable'
    let code = 'TRANSPORT'
    if (lastStatus === 401) code = 'AUTH'
    else if (lastStatus === 403) code = 'FORBIDDEN'
    else if (lastStatus === 429) code = 'RATE_LIMIT'
    else if (lastStatus >= 500) code = 'SERVER'
    const errorContext = {}
    if (lastStatus > 0) errorContext.status = lastStatus
    if (lastError !== undefined) errorContext.cause = lastError
    throw kiroError(message, code, errorContext)
  }

  /**
   * Wait for one slot in the in-flight gate.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<void>} resolves when a slot is free.
   */
  async acquire(signal) {
    const limit = Math.max(1, Number(this.connection().maxConcurrency ?? 2))
    if (this.inflight < limit) {
      this.inflight += 1
      return
    }
    await new Promise((resolve, reject) => {
      const waiter = () => {
        signal.removeEventListener('abort', onAbort)
        this.inflight += 1
        resolve()
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(kiroError('Kiro request aborted while queued', 'ABORTED'))
      }
      this.waiters.push(waiter)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Release one slot and hand it to the next waiter. */
  release() {
    this.inflight = Math.max(0, this.inflight - 1)
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }

  /** Drop every cached reading, after a login, logout, or account switch. */
  clear() {
    this.catalogCache.clear()
    this.usageCache.clear()
    this.profileCache.clear()
  }

  /**
   * Build the wire context a request translator needs.
   *
   * The translators are pure functions, so everything the wire operation needs
   * to know about *this* account — its profile ARN, whether the selected model
   * accepts an effort field and which levels it declares, and the bounds of its
   * `max_tokens` — is resolved here once and handed over as data.
   *
   * @param {string} modelId - exact model id the caller selected.
   * @param {string|number|undefined} requestedEffort - the caller's effort, if any.
   * @param {string} [conversationId] - conversation identity to reuse.
   * @returns {Promise<object>} `{ conversationId, modelId, profileArn?, effort?, maxTokensBounds? }`.
   */
  async wireContext(modelId, requestedEffort, conversationId) {
    const connection = this.connection()
    const { token } = await this.authenticate(undefined)
    let catalog
    try {
      catalog = await this.models(undefined, false)
    } catch {
      // A catalog failure must not block a request: the model id the caller
      // named is still sent, and only the optional fields are dropped.
      catalog = []
    }
    const model = catalog.find(entry => entry.id === modelId)
    const wanted = typeof requestedEffort === 'string' && requestedEffort.length > 0
      ? requestedEffort
      : model?.defaultReasoningEffort
    const levels = model?.reasoningEfforts ?? []
    const effort = model?.supportsEffort === true && wanted !== undefined && levels.includes(wanted)
      ? { schemaPath: model.effortSchemaPath ?? 'output_config', level: wanted }
      : undefined
    const context = {
      conversationId: conversationId != null ? conversationId : randomUUID(),
      modelId,
    }
    if (token.profileArn !== undefined) context.profileArn = token.profileArn
    if (effort !== undefined) context.effort = effort
    if (model?.maxTokensBounds !== undefined) context.maxTokensBounds = model.maxTokensBounds
    if (model?.contextWindow !== undefined) context.contextWindow = model.contextWindow
    if (connection.proxyUrl !== undefined) context.proxyUrl = connection.proxyUrl
    return context
  }

  /**
   * Send one already-serialized wire request and yield normalized events.
   *
   * Split out from {@link KiroClient.stream} so that the reverse proxy — whose
   * translators produce the wire body directly, from a different input protocol
   * — does not have to round-trip through the Harness message vocabulary.
   * @param {object} body - the `generateAssistantResponse` request body.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {{ contextWindow?: number }} [extra] - the routed model's advertised capacity.
   * @returns {AsyncGenerator<object>} normalized events, ending with `{ kind: 'stop' }`.
   */
  async *sendWire(body, signal = new AbortController().signal, extra = {}) {
    const connection = this.connection()
    const { token } = await this.authenticate(signal)
    const region = connection.region != null ? connection.region : token.region
    const configured = Number(connection.retryAttempts)
    const attempts = Number.isInteger(configured) && configured > 0 ? configured : 3
    // The body may have been built before the ARN was discovered (or by a caller
    // that never had one); an IdC request without it is refused, so fill it in.
    const wire = token.profileArn !== undefined && body?.profileArn === undefined
      ? { ...body, profileArn: token.profileArn }
      : body
    const payload = JSON.stringify(wire)
    const extraHeaders = {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
      'Amz-Sdk-Request': `attempt=1; max=${attempts}`,
      'Amz-Sdk-Invocation-Id': randomUUID(),
      'x-amzn-kiro-agent-mode': 'vibe',
    }
    const needsTarget = token.method === 'idc' || token.method === 'external_idp'
    if (needsTarget) extraHeaders['x-amz-target'] = CODEWHISPERER_TARGET
    const headers = kiroHeaders(token, extraHeaders)

    let lastFailure
    let lastHint
    // 首选面记在实例上：一次成功之后，后续请求直接走它，少一次试错往返。
    const surf = `${region}\u0000${token.method}`
    const preferred = this.surfacePreference.get(surf)
    const candidates = kiroEndpointCandidates(region, token.method)
    if (preferred !== undefined) {
      const index = candidates.indexOf(preferred)
      if (index > 0) candidates.unshift(...candidates.splice(index, 1))
    }

    await this.acquire(signal)
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        signal.throwIfAborted()
        // 一轮尝试里把每个数据面都过一遍：节流与过载都是按面计的，
        // 换面往往立刻就能答，比原地等着快得多。
        for (const url of candidates) {
          let response
          try {
            response = await this.post({
              url,
              // 每次出站都要新的调用 id，否则服务端会把重试当成同一次调用的重放。
              headers: { ...headers, 'Amz-Sdk-Invocation-Id': randomUUID() },
              body: payload,
              signal,
              ...(connection.proxyUrl !== undefined ? { proxyUrl: connection.proxyUrl } : {}),
            })
          } catch (error) {
            lastFailure = error
            if (isTransient(error)) continue
            throw error
          }

          const hint = retryAfterMs(response.headers)
          if (hint !== undefined) lastHint = hint

          if (response.status !== 200) {
            const raw = await responseText(response)
            let parsed
            try {
              parsed = JSON.parse(raw)
            } catch {
              parsed = undefined
            }
            const failure = statusError(
              response.status,
              parsed,
              // A proxy or gateway error page is HTML; keeping its first line makes the
              // failure diagnosable without pasting a whole page into the transcript.
              raw.length > 0 && parsed === undefined ? raw.split('\n')[0].slice(0, 300) : undefined,
              typeof response.headers['x-amzn-requestid'] === 'string' ? response.headers['x-amzn-requestid'] : undefined,
              hint,
            )
            lastFailure = failure
            // 429/5xx 可能只是这个面在过载：换下一个面。
            if (failure.code === 'RATE_LIMIT' || failure.code === 'SERVER') continue
            throw failure
          }

          // 先看第一帧：过载常常是以 200 + `:exception-type` 帧到达的，此时还
          // 一个字节都没吐给调用方，换面重来是最便宜的处理。
          const iterator = decodeFrames(response.body)[Symbol.asyncIterator]()
          let first = await iterator.next()
          if (!first.done && first.value.headers[':exception-type'] !== undefined) {
            const exception = first.value.headers[':exception-type']
            let detail
            try {
              detail = JSON.parse(Buffer.from(first.value.payload).toString('utf8'))
            } catch {
              detail = undefined
            }
            const failure = statusError(500, detail, `Kiro stream failed: ${exception}`)
            lastFailure = failure
            if (isTransient(failure)) {
              // 清掉首选面，让下一轮从另一个面开始（本轮继续按原顺序试下一个面）。
              this.surfacePreference.delete(surf)
              await iterator.return?.()
              continue
            }
            throw failure
          }

          this.surfacePreference.set(surf, url)

          // 观测到的事实：这条流到底有没有出现过工具调用。Kiro 在「模型只调工具、
          // 没有可见文本」的路由上会整块不发 metadataEvent（实测 opus-5.5 只发
          // toolUseEvent×2 + contextUsage + metering 四帧），此时 stopReason 必须由
          // 已发生的事件推导，否则调用方会把它当成「正常说完」，工具永远不执行。
          let stopReason
          let sawTool = false
          // Kiro 用这对帧收尾（普通回答没有 metadataEvent）；它们的出现就是"这条流
          // 说完了"的证据，缺了才是可疑的截断。
          let sawTerminalUsage = false
          let usage
          let contextPercentage
          let yieldedAny = false
          const openTools = new Set()
          // Kiro reports exact input buckets on some routes and nothing on others, and
          // never reports an output bucket on the routes observed here. Counting the
          // characters it emitted is the only remaining signal, and every consumer
          // (Harness token meter, both proxy surfaces) needs one number rather than
          // three different guesses, so it is measured once here.
          let emittedCharacters = 0
          let emittedTextCharacters = 0

          const handle = (frame) => {
            const exceptionType = frame.headers[':exception-type']
            if (exceptionType !== undefined) {
              // 内容已经开始之后再失败就没有"重来"这个选项：重发会让调用方看到
              // 重复的前半段。按失败上报，由上层决定怎么收场。
              let detail
              try {
                detail = JSON.parse(Buffer.from(frame.payload).toString('utf8'))
              } catch {
                detail = undefined
              }
              throw statusError(500, detail, `Kiro stream failed: ${exceptionType}`)
            }
            const eventType = frame.headers[':event-type']
            if (eventType === undefined) return undefined
            let parsed
            try {
              parsed = JSON.parse(Buffer.from(frame.payload).toString('utf8'))
            } catch (error) {
              throw kiroError(`Kiro sent an unparsable ${eventType} payload`, 'MALFORMED_RESPONSE', { cause: error })
            }
            const event = normalizeWireEvent(eventType, parsed)
            if (event === undefined) return undefined
            if (event.kind === 'metadata') {
              stopReason = event.stopReason
              if (event.usage !== undefined) usage = event.usage
              return undefined
            }
            if (event.kind === 'context-usage') {
              contextPercentage = event.percentage
              sawTerminalUsage = true
              return undefined
            }
            if (event.kind === 'metering') {
              sawTerminalUsage = true
              return undefined
            }
            if (event.kind === 'text' || event.kind === 'reasoning') emittedCharacters += event.text.length
            // 只有正文算"用户真的看到了答案"：截断判定与空回合判定都需要这个
            // 比 emittedCharacters 更窄的信号，reasoning 不算。
            if (event.kind === 'text') emittedTextCharacters += event.text.length
            if (event.kind === 'tool-delta') emittedCharacters += event.argumentsDelta.length
            if (event.kind === 'tool-start' || event.kind === 'tool-delta') sawTool = true
            if (event.kind === 'tool-start') openTools.add(event.id)
            if (event.kind === 'tool-stop') openTools.delete(event.id)
            return event
          }

          // 第一帧已经读过了，所以先处理它，再接着流式读剩下的。
          if (!first.done) {
            const event = handle(first.value)
            if (event !== undefined) {
              yieldedAny = true
              yield event
            }
          }
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            const event = handle(next.value)
            if (event === undefined) continue
            yieldedAny = true
            yield event
          }

          // 一个内容事件都没有：Kiro 对"它不愿执行"的输入只回 contextUsageEvent。
          // 这里不假装正常结束，而是把事实交给上层（stream() 会据此换模型重试）。
          if (!yieldedAny && openTools.size === 0) {
            yield { kind: 'empty', contextPercentage: usage?.contextPercentage ?? contextPercentage }
            return
          }
          // A stream that ends with a tool still open is a truncated tool call: closing
          // it here lets the consumer finalize the block instead of dropping it.
          for (const id of openTools) yield { kind: 'tool-stop', id }
          if (stopReason === undefined) {
            // 文本已经发出去却没有任何终止帧 = 流被截断，不是正常说完。
            // 这里如实交给上层（STREAM_CLOSED 在可重试码里，Harness 会重发这一轮），
            // 而不是补一个 END_TURN 把半句话标成"已完成"。
            stopReason = deriveStopReason({
              sawTool,
              openToolCount: openTools.size,
              visibleCharacters: emittedTextCharacters,
              sawTerminalUsage,
            })
          }
          const percentage = usage?.contextPercentage ?? contextPercentage
          const contextWindow = extra.contextWindow
          const hasWindow = typeof contextWindow === 'number' && contextWindow > 0
          const estimatedInput = percentage !== undefined && hasWindow
            ? Math.round(percentage / 100 * contextWindow)
            : undefined
          const reportedInput = usage === undefined || usage.inputTokens === 0 ? undefined : usage.inputTokens
          const reportedOutput = usage?.outputTokens === 0 ? undefined : usage?.outputTokens
          const estimatedOutput = emittedCharacters === 0
            ? undefined
            : Math.max(1, Math.round(emittedCharacters / 3.6))
          yield {
            kind: 'usage',
            inputTokens: reportedInput ?? estimatedInput ?? 0,
            outputTokens: reportedOutput ?? estimatedOutput ?? 0,
            ...usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
            ...usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
            ...reportedInput === undefined || reportedOutput === undefined ? { estimated: true } : {},
            ...percentage === undefined ? {} : { contextPercentage: percentage },
          }
          yield { kind: 'stop', stopReason }
          return
        }

        // 这一轮里每个面都过载了：把顺序轮换一格（下一轮从上次失败的面之后开始），
        // 退避后再来一轮。
        candidates.push(candidates.shift())
        if (attempt < attempts) {
          await this.sleep(this.backoff(attempt, lastHint))
          continue
        }
      }
      // 走到这里说明每轮都"可重试"地失败了；把最后一次的真实原因抛出去。
      throw lastFailure ?? kiroError('Kiro request failed on every surface and retry', 'SERVER')
    } finally {
      this.release()
    }
  }

  /**
   * Exponential backoff with jitter.
   *
   * Jitter matters more than the constant: the editor and the agent loop can
   * retry at the same moment, and two synchronized retries re-create the burst
   * that caused the throttle.
   * @param {number} attempt - 1-based attempt number.
   * @param {number} [hint] - server-provided delay in milliseconds.
   * @returns {number} milliseconds to wait.
   */
  backoff(attempt, hint) {
    if (hint !== undefined) return Math.min(hint, 30_000)
    const base = Math.min(500 * 2 ** (attempt - 1), 8_000)
    return Math.round(base * (0.7 + Math.random() * 0.6))
  }

  /**
   * Send one Harness-shaped conversation and yield normalized events.
   *
   * @param {object} options - Harness-shaped request: `{ model, messages, system, tools, reasoningEffort, maxTokens, signal }`.
   * @param {{ conversationId?: string, modelId?: string, images?: Map<string, object> }} [extra]
   * @returns {AsyncGenerator<object>} normalized events, ending with `{ kind: 'stop' }`.
   */
  async *stream(options, extra = {}) {
    const signal = options.signal != null ? options.signal : new AbortController().signal
    const connection = this.connection()
    const { token } = await this.authenticate(signal)
    const region = connection.region != null ? connection.region : token.region
    // 目录决定 effort 的字段名、max_tokens 的边界与上下文窗口；没有它请求仍能
    // 发出，但会丢掉这三个只能由服务端告知的事实。首次请求顺带拉一次（有 5 分钟
    // 缓存），失败则降级成"只发调用方给的东西"。
    const catalog = this.cachedCatalog(region, token.profileArn, connection.proxyUrl)
      ?? await this.models(signal, false).catch(() => undefined)
    const requestedModel = extra.modelId ?? options.model
    // 有些模型对某些提示词只回一个空流（实测 claude-opus-5.5 / gpt-5.6-sol 等），
    // 换一个模型往往能答。这比"整轮失败、用户什么也看不到"有用得多，所以空响应时
    // 自动按候选表换模型重来一次。
    const candidates = this.fallbackChain(requestedModel, catalog, connection)
    // 「只想不做」的续写：Kiro 有时只发 reasoning、然后以 END_TURN/PAUSE_TURN 收尾，
    // 一个可见字节都没有。Kiro 自己的客户端遇到这种空轮会补一条 "continue" 再问一次
    // （它 serializeToContext 里对空轮就是 `{role:'human', content:'continue'}`）。
    // 不补的话，用户看到的就是"说到一半断了"，必须手动输入"继续"。
    const autoContinue = connection.autoContinue !== false
    const maxContinuations = Number.isInteger(connection.maxContinuations) && connection.maxContinuations >= 0
      ? connection.maxContinuations
      : 2
    let lastEmpty
    for (const candidate of candidates) {
      const modelInfo = catalog?.find(entry => entry.id === candidate)
      const conversationId = extra.conversationId
        ?? (typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : randomUUID())
      const originalMessages = Array.isArray(options.messages) ? [...options.messages] : []
      const baseMessages = [...originalMessages]
      let continuations = 0
      let freshRetries = 0
      for (;;) {
        const { body } = serializeRequest({ ...options, model: candidate, messages: baseMessages }, {
          conversationId,
          modelId: candidate,
          profileArn: token.profileArn,
          effort: modelInfo?.supportsEffort === true
            ? {
              schemaPath: modelInfo.effortSchemaPath ?? 'output_config',
              level: String(options.reasoningEffort ?? modelInfo.defaultReasoningEffort ?? 'medium'),
            }
            : undefined,
          maxTokensBounds: modelInfo?.maxTokensBounds,
          ...connection.maxRequestChars === undefined ? {} : { maxRequestChars: connection.maxRequestChars },
          images: extra.images,
        })

        let empty
        let sawVisible = false
        let sawReasoning = false
        // sendWire 每发完一个请求就吐 usage + stop，那是给单请求调用方（反代）用的
        // 终止信号。在这里它还不能出去：一旦续写，这个 stop 会让适配器先收尾，
        // 续写拿到的正文就落在 finish 之后，用户看到的是一轮"只有思考、没有正文"。
        // 所以先扣住，决定不再续写时再按原顺序补发。
        const terminal = []
        for await (const event of this.sendWire(body, signal, {
          ...modelInfo?.contextWindow === undefined ? {} : { contextWindow: modelInfo.contextWindow },
        })) {
          if (event.kind === 'empty') {
            empty = event
            break
          }
          if (event.kind === 'usage' || event.kind === 'stop') {
            terminal.push(event)
            continue
          }
          if (event.kind === 'text' || event.kind === 'tool-start' || event.kind === 'tool-delta') sawVisible = true
          if (event.kind === 'reasoning') sawReasoning = true
          yield event
        }

        if (empty !== undefined) {
          lastEmpty = empty
          break
        }
        // 只有"想了但什么都没说、也没调工具"才续写：真的答完了不该再问一次。
        if (autoContinue && !sawVisible && sawReasoning) {
          if (continuations < maxContinuations) {
            // 这一轮的 usage/stop 属于半截回答，丢掉；续写成功后再发真正的收尾。
            continuations += 1
            // 先补一条 assistant 占位再补 "continue"：连续两条 user 会被合并成一轮，
            // 模型看到的就变成"原始问题 + continue"粘在一起，而不是"你说完了，继续"。
            // Kiro 自己的客户端就是这么发空轮续写的（bot: understood / human: continue）。
            baseMessages.push({ role: 'assistant', content: [{ type: 'text', text: '' }] })
            baseMessages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] })
            continue
          }
          // 续写预算用尽后仍然只有思考：用原始请求再试一次（不发 continue）。
          // 实测模型对同样的输入偶尔会只输出思考，换一次采样往往能拿到正文。
          // 这比让用户看到一次错误提示、再手动重试要平滑。
          if (freshRetries < 1) {
            freshRetries += 1
            baseMessages.length = 0
            baseMessages.push(...originalMessages)
            continue
          }
        }
        for (const event of terminal) yield event
        if (candidate !== requestedModel) this.lastFallback = { from: requestedModel, to: candidate, at: Date.now() }
        return
      }
    }
    // 每个候选都空：如实上报一次空回合（上层据此报 CONTENT_FILTERED）。
    yield {
      kind: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      estimated: true,
      ...lastEmpty?.contextPercentage === undefined ? {} : { contextPercentage: lastEmpty.contextPercentage },
    }
    yield { kind: 'stop', stopReason: 'END_TURN' }
  }

  /**
   * 空响应时可以换用的模型顺序。
   * @param {string} requested - 调用方选中的模型。
   * @param {object[]|undefined} catalog - 账号的模型目录。
   * @param {object} connection - 连接事实（含 fallbackModels 覆盖）。
   * @returns {string[]} 依次尝试的模型 id，第一个永远是用户选中的那个。
   */
  fallbackChain(requested, catalog, connection) {
    if (connection.fallbackOnEmpty === false) return [requested]
    const configured = Array.isArray(connection.fallbackModels) && connection.fallbackModels.length > 0
      ? connection.fallbackModels.filter(id => typeof id === 'string' && id.length > 0)
      : DEFAULT_FALLBACK_MODELS
    const known = new Set((catalog ?? []).map(entry => entry.id))
    // 用户选的模型必须排第一；后面的候选只在目录里存在时才用，避免把请求发给
    // 账号根本没有的模型。
    const chain = [requested, ...configured.filter(id => id !== requested && (known.size === 0 || known.has(id)))]
    return [...new Set(chain)]
  }

  /**
   * Read a cached catalog entry without I/O.
   * @param {string} region - catalog region.
   * @param {string|undefined} profileArn - profile ARN.
   * @param {string|undefined} proxyUrl - proxy egress.
   * @returns {object[] | undefined} the cached models.
   */
  cachedCatalog(region, profileArn, proxyUrl) {
    const key = `${region}\u0000${profileArn ?? ''}\u0000${proxyUrl ?? ''}`
    const entry = this.catalogCache.get(key)
    return entry !== undefined && entry.expiresAt > Date.now() ? entry.models : undefined
  }
}

/**
 * Read an epoch timestamp from either of the two encodings Kiro uses.
 *
 * `nextDateReset` arrives as Unix **seconds** (`1793491200`), while credential
 * expiry arrives as an ISO string. Reading seconds as milliseconds would put the
 * reset date in 1970, so the magnitude decides the unit.
 * @param {unknown} value - epoch seconds, epoch milliseconds, or an ISO string.
 * @returns {number | undefined} epoch milliseconds.
 */
function epochMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const raw = text(value)
  if (raw === undefined) return undefined
  if (/^\d+$/u.test(raw)) return epochMillis(Number(raw))
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parse a GetUsageLimits response into a displayable snapshot.
 * @param {unknown} value - decoded response.
 * @param {number} [now] - current epoch milliseconds, injectable for tests.
 * @returns {{ plan: string, rows: object[], fetchedAt: number }}
 */
export function parseUsage(value, now = Date.now()) {
  const root = record(value)
  if (root === undefined || !Array.isArray(root.usageBreakdownList)) {
    throw kiroError('Kiro GetUsageLimits returned no usage breakdown', 'MALFORMED_RESPONSE')
  }
  const breakdowns = root.usageBreakdownList
  const resetAt = epochMillis(root.nextDateReset != null ? root.nextDateReset : root.resetDate)
  const rows = []
  for (const entry of breakdowns) {
    const item = record(entry)
    if (item === undefined) continue
    const label = text(item.displayName) ?? text(item.resourceType) ?? text(item.usageType) ?? 'Credits'
    const used = Number(item.currentUsageWithPrecision ?? item.currentUsage ?? 0)
    const limit = Number(item.usageLimitWithPrecision ?? item.usageLimit ?? 0)
    if (!Number.isFinite(used) || !Number.isFinite(limit)) continue
    const row = { label, used, limit }
    if (resetAt !== undefined) row.resetAt = resetAt
    const currency = text(item.currency)
    if (currency !== undefined) row.currency = currency
    rows.push(row)
  }
  if (rows.length === 0) throw kiroError('Kiro GetUsageLimits returned no usable usage rows', 'MALFORMED_RESPONSE')
  const subscription = record(root === undefined ? undefined : root.subscriptionInfo)
  const title = subscription === undefined ? undefined : text(subscription.subscriptionTitle)
  const snapshot = { plan: title !== undefined ? title : 'Kiro', rows, fetchedAt: now }
  if (resetAt !== undefined) snapshot.resetAt = resetAt
  return snapshot
}
