/**
 * The Harness `llm` adapter for the Kiro route.
 *
 * This is deliberately not a subclass of the Harness's `LlmAdapter` class: a
 * bundle installed into a profile resolves its own package graph, and importing
 * the Harness package to extend it would either duplicate the class (making
 * `instanceof` fail in the registry) or couple the install to a version. The
 * service duck-types the adapter — it calls the methods it needs — so the
 * contract is honored structurally, exactly as it is documented.
 *
 * @module dsh-kiro-proxy/adapter
 */

import { kiroError } from './kiro-error.js'

/** Largest image Kiro accepts, matching the bounds of the service behind it. */
const IMAGE_TARGET = { width: 8000, height: 8000, maxBytes: 3_750_000 }
/** Context capacity to report when discovery says nothing. */
const DEFAULT_CONTEXT_WINDOW = 200_000
/**
 * 上报给 Harness 的上下文上限（未显式配置时）。
 *
 * 目录里 `claude-opus-5.5` 报 1M，但 Kiro 的数据面对长报文会直接回
 * `Input is too long.`。报满 1M 等于告诉 Harness「不用压缩」，于是每轮都撞墙；
 * 报 200k 才会让 Harness 在合适的时候压缩，插件那边的字符预算只是兜底。
 */
const DEFAULT_CONTEXT_CEILING = 200_000
/** Effort vocabulary for a model whose live schema has not been read yet. */
const FALLBACK_EFFORTS = ['off', 'low', 'medium', 'high']

/**
 * Normalize one catalog entry into the Harness's resolved-model shape.
 * @param {string} provider - the registered route.
 * @param {object} model - a catalog entry from {@link KiroClient.models}.
 * @param {number|undefined} cap - ceiling applied to the reported capacity.
 * @returns {object} `LlmResolvedModelInfo`.
 */
function resolvedModel(provider, model, cap) {
  const reported = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const ceiling = cap === undefined ? DEFAULT_CONTEXT_CEILING : cap
  const contextWindow = Math.min(reported, ceiling)
  const efforts = model.supportsEffort === true
    ? model.reasoningEfforts.map(level => ({ id: level, name: level }))
    : FALLBACK_EFFORTS.map(level => ({ id: level, name: level }))
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description ? { description: model.description } : {}),
    ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    context: { contextWindow },
    ...(model.maxTokens ? { defaultMaxTokens: model.maxTokens } : {}),
    // Kiro has no system slot: the Harness system prompt travels inside the
    // first user turn, so the Harness must treat it as history content rather
    // than as a separate request field it would otherwise expect.
    systemPromptUpdate: 'in-history',
    reasoning: {
      efforts,
      ...model.supportsEffort !== true
        ? { defaultEffort: 'off' }
        : model.defaultReasoningEffort === undefined ? {} : { defaultEffort: model.defaultReasoningEffort },
    },
  }
}

/**
 * The Kiro adapter instance.
 */
export class KiroProxyAdapter {
  /**
   * @param {{ client: import('./kiro-client.js').KiroClient, provider: string, displayName?: string, cap?: () => number|undefined }} deps
   */
  constructor(deps) {
    this.client = deps.client
    this.provider = deps.provider
    this.displayName = deps.displayName ?? 'Kiro'
    this.cap = deps.cap ?? (() => undefined)
  }

  /**
   * Describe this route.
   * @param {string} provider - route id.
   * @returns {{ id: string, name: string }}
   */
  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /**
   * Retry policy: the normal bounded policy, but quota exhaustion is terminal.
   * @returns {object} a resolved retry policy.
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      // 插件内部已经重试 3 次（含并发闸门与 retry-after 退避），这里再给 3 次
      // 是给「连续多轮都被节流」留余量，而不是替代内部重试。
      maxRetries: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 20_000,
      jitterRatio: 0.2,
      // `QUOTA` and `CONTEXT_WINDOW_EXCEEDED` are absent on purpose: retrying an
      // exhausted allowance or an oversized request repeats the same answer.
      // `EMPTY_RESPONSE` / `CONTENT_FILTERED` 都不在列表里：同一份被拒的提示词
      // 重发一次也是同样的空响应，重试只会让用户多等十几秒。
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'STREAM_CLOSED', 'EMPTY_RESPONSE'],
    }
  }

  /**
   * Kiro has no per-image pricing model to report.
   * @returns {undefined}
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Kiro re-encodes images to a fixed bound before accepting them.
   * @returns {{ width: number, height: number, maxBytes: number }}
   */
  imageRequestTarget() {
    return IMAGE_TARGET
  }

  /**
   * List the account's models.
   * @param {string} provider - route id.
   * @returns {Promise<object[]>} `LlmModelInfo[]`.
   */
  async listModels(provider) {
    const models = await this.client.models(undefined, false)
    const enabled = this.client.connection().enabledModels
    return models
      .filter(model => enabled === undefined || enabled.length === 0 || enabled.includes(model.id))
      .map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...(model.description ? { description: model.description } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
      }))
  }

  /**
   * Resolve one exact model.
   *
   * An unknown id still resolves: the catalog is advisory, and refusing a model
   * the service would accept would break a session that was working before a
   * catalog refresh.
   * @param {string} provider - route id.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} `LlmResolvedModelInfo`.
   */
  async resolveModel(provider, model, signal) {
    let catalog
    try {
      catalog = await this.client.models(signal, false)
    } catch (error) {
      if (signal?.aborted === true) throw error
      catalog = []
    }
    const entry = catalog.find(candidate => candidate.id === model)
    return resolvedModel(provider, entry ?? { id: model, name: model }, this.cap())
  }

  /**
   * Prepare one call, binding the model facts the dispatch will use.
   * @param {string} provider - route id.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ model: object, stream: (options: object) => AsyncIterable<object> }>}
   */
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal)
    return {
      model: info,
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call as raw Harness chunks.
   *
   * The mapping is the whole point of the adapter: Kiro's frames carry text,
   * out-of-band reasoning, and tool-call fragments, and the Harness expects
   * indexed blocks that start, grow, and close in that order.
   * @param {object} options - the Harness request.
   * @returns {AsyncIterable<object>} `StreamChunk`s.
   */
  async *stream(options) {
    /** Open block index -> its accumulated content. */
    const blocks = new Map()
    /** Wire tool-use id -> block index. */
    const toolBlocks = new Map()
    let nextIndex = 0
    let textIndex
    let reasoningIndex
    let finish
    let usage
    let emittedToolCallSeen = false
    // 一个块都没产出就结束，等于「用户发了消息、界面什么都没出现」。
    // 明确报成 EMPTY_RESPONSE 才会在 UI 上留下可见的失败，而不是静默空回合。
    let emittedBlocks = 0
    /** 是否真的产出过正文（reasoning 不算：用户看不到它）。 */
    let emittedTextSeen = false

    try {
      for await (const event of this.client.stream(options, { modelId: options.model })) {
        if (event.kind === 'text') {
          if (textIndex === undefined) {
            emittedBlocks += 1
            emittedTextSeen = true
            textIndex = nextIndex
            nextIndex += 1
            blocks.set(textIndex, { type: 'text', text: '' })
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          blocks.get(textIndex).text += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
          continue
        }
        if (event.kind === 'reasoning') {
          // A reasoning run that follows text is a new block; Kiro delivers each
          // run contiguously, so the previous one is already closed.
          if (reasoningIndex === undefined) {
            emittedBlocks += 1
            reasoningIndex = nextIndex
            nextIndex += 1
            blocks.set(reasoningIndex, { type: 'reasoning', text: '' })
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          blocks.get(reasoningIndex).text += event.text
          yield { type: 'reasoning-delta', index: reasoningIndex, text: event.text }
          continue
        }
        if (event.kind === 'tool-start') {
          // 同一个 toolUseId 只允许一个块：重复的"开始"帧直接忽略，否则下一步会
          // 因为两个块共用一个 id 而被服务端判为 Improperly formed request.
          if (toolBlocks.has(event.id)) continue
          const index = nextIndex
          nextIndex += 1
          toolBlocks.set(event.id, index)
          emittedToolCallSeen = true
          emittedBlocks += 1
          blocks.set(index, { type: 'tool-call', id: event.id, name: event.name, arguments: '' })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: event.id, name: event.name, argumentsDelta: '' }
          continue
        }
        if (event.kind === 'tool-delta') {
          let index = toolBlocks.get(event.id)
          if (index === undefined && !toolBlocks.has(event.id)) {
            // 没有 start 帧就来参数：部分路由把 name 与首个参数片段合在一帧里，
            // 所以这里惰性建块而不是报错 —— 报错会整轮失败，建块最多丢一次名字。
            index = nextIndex
            nextIndex += 1
            toolBlocks.set(event.id, index)
            blocks.set(index, { type: 'tool-call', id: event.id, name: '', arguments: '' })
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          const block = blocks.get(index)
          block.arguments += event.argumentsDelta
          if (typeof event.name === 'string' && event.name.length > 0) block.name = event.name
          yield {
            type: 'tool-call-delta',
            index,
            id: event.id,
            ...block.name === '' ? {} : { name: block.name },
            argumentsDelta: event.argumentsDelta,
          }
          continue
        }
        if (event.kind === 'tool-stop') {
          const index = toolBlocks.get(event.id)
          if (index === undefined) continue
          const block = blocks.get(index)
          yield {
            type: 'block-end',
            index,
            // 空参数必须写成 "{}"：Harness 与 OpenAI 客户端都会对它做 JSON.parse，
            // 空串是一个必然失败的输入。
            block: {
              type: 'tool-call',
              id: block.id,
              name: block.name,
              arguments: block.arguments.length > 0 ? block.arguments : '{}',
            },
          }
          blocks.delete(index)
          // 已关闭的调用不留痕：同一个 id 若真的再出现（新一轮调用），应当能重新开块；
          // 但同一轮里重复的 start/open 已经在上面被 toolBlocks.has 挡掉了。
          toolBlocks.delete(event.id)
          continue
        }
        if (event.kind === 'usage') {
          usage = event
          continue
        }
        if (event.kind === 'stop') {
          finish = event.stopReason
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Kiro request aborted', code: 'ABORTED' } } }
        return
      }
      throw error
    }

    // A stream that ended without a tool's stop frame is a truncated tool call.
    // Closing it here keeps the call rather than dropping a block the model
    // already began: a dropped tool call is a silently lost action.
    for (const [index, block] of blocks) {
      if (block.type === 'text') yield { type: 'block-end', index, block: { type: 'text', text: block.text } }
      else if (block.type === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
      else if (block.type === 'tool-call') {
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: block.id,
            name: block.name,
            arguments: block.arguments.length > 0 ? block.arguments : '{}',
          },
        }
      }
    }
    blocks.clear()

    if (usage !== undefined) {
      const inputTokens = usage.inputTokens ?? 0
      const outputTokens = usage.outputTokens ?? 0
      const cacheReadTokens = usage.cacheReadTokens ?? 0
      const cacheWriteTokens = usage.cacheWriteTokens ?? 0
      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
      }
    }

    // 已经产出工具块却报 stop，Harness 不会去执行它 —— agent 的循环会静默死掉。
    // 这类路由（无 metadataEvent）已验证存在，所以这里按事实兜底而不是相信 stopReason。
    const emittedToolCall = toolBlocks.size > 0 || emittedToolCallSeen
    // 只有思考、没有正文也没有工具：客户端已经自动续写过（autoContinue），续写仍然
    // 这个形状时，这一轮对用户来说就是"没有结果就结束了"。报成成功等于把空白当答案，
    // 所以明确失败并允许重试一次 —— 换一次调用往往就有正文了。
    const visible = emittedTextSeen || emittedToolCall
    const reason = finishReason(finish)
    if (reason.kind === 'stop' && !visible && emittedBlocks > 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'Kiro 这一轮只输出了思考，没有正文也没有工具调用（续写后仍然为空）。'
              + '再发一次通常能拿到结果。',
            code: 'EMPTY_RESPONSE',
          },
        },
      }
      return
    }
    // 顺序很重要：工具块优先（否则工具循环静默死掉），其次空回合（否则 UI 一片空白）。
    const final = emittedToolCall && reason.kind === 'stop'
      ? { kind: 'tool-calls' }
      : reason.kind === 'stop' && emittedBlocks === 0
        ? {
          kind: 'error',
          failure: {
            // 实测：Kiro 对"拒绝执行"的输入不回任何拒绝文本，只发一个
            // contextUsageEvent 就结束（HTTP 200、零内容帧）。所以空回合几乎
            // 总是上游拒答，而不是网络问题 —— 提示词必须指向真正的原因，
            // 否则用户会一直以为是自己网断了。
            message: 'Kiro 返回了空响应：选中的模型与所有备用模型都拒绝为本轮输入生成内容（Kiro 不会附带拒绝文本）。'
              + '通常是项目指令 / system prompt 里含有要求模型"不要拒绝""屏蔽拒答话术"之类的内容。'
              + '换一个不含此类指令的会话即可正常对话。',
            code: 'CONTENT_FILTERED',
          },
        }
        : reason
    yield { type: 'finish', reason: final }
  }
}

/**
 * Map a Kiro stop reason onto the Harness's finish vocabulary.
 *
 * An unrecognized reason fails the turn instead of reporting success: a silent
 * "stop" on a truncated stream is indistinguishable from a completed answer.
 * @param {string|undefined} raw - `stopReason` from the terminal metadata event.
 * @returns {object} a `FinishReason`.
 */
export function finishReason(raw) {
  switch (raw) {
    case 'END_TURN':
      return { kind: 'stop' }
    case 'TOOL_USE':
      return { kind: 'tool-calls' }
    case 'MAX_TOKENS':
    case 'MODEL_CONTEXT_WINDOW_EXCEEDED':
      return { kind: 'max-tokens' }
    case 'PAUSE_TURN':
      // Kiro 自己把这一轮停在中途。报成 stop 会让半句话显示成"回答完毕"，
      // 用户唯一的线索就是文字突然没了 —— 这正是「没拿到结果就断了」。
      return {
        kind: 'error',
        failure: {
          message: 'Kiro 在这一轮中途暂停了（PAUSE_TURN），上面的内容是被截断的，不是完整回答。'
            + '重发一次通常能拿到完整结果。',
          code: 'PAUSE_TURN',
        },
      }
    case 'CONTENT_FILTERED':
      return {
        kind: 'error',
        failure: {
          message: 'Kiro 因内容策略结束了这一轮（CONTENT_FILTERED），上面的内容是截断的。'
            + '同一份输入重发会得到同样的结果，需要改写触发过滤的那部分内容。',
          code: 'CONTENT_FILTERED',
        },
      }
    case 'STREAM_CLOSED':
      // 正文已经流出、却没有任何终止帧：连接在回答中途断了。STREAM_CLOSED
      // 在可重试码表里，所以这一轮会被重发，而不是留半句话当成品。
      return {
        kind: 'error',
        failure: {
          message: 'Kiro 的流在回答中途结束，没有收到终止帧；上面的内容是截断的。',
          code: 'STREAM_CLOSED',
        },
      }
    default:
      return {
        kind: 'error',
        failure: { message: `Kiro ended the turn with an unrecognized stop reason "${String(raw)}"`, code: 'MALFORMED_RESPONSE' },
      }
  }
}
