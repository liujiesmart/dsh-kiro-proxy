# dsh-kiro-proxy 内部契约（Lead 制定，所有模块共用）

本文件是各模块之间的接口契约。修改契约前必须先改本文件并通知 Lead。

## 0. 插件定位

`dsh-kiro-proxy` 是一个 DeepSeek Harness bundle，做两件事：

1. **Host 侧 provider 路由**：注册 `llm` adapter，route 名 `kiro-proxy`，把 Harness 的
   `GenerateOptions` 直接打到 Kiro 的 `generateAssistantResponse`（AWS EventStream）。
2. **反向代理**：在 Host 的 `webServer` 上挂 `/v1/*`（OpenAI 兼容）与 `/kiro-proxy/v1/*`
   （Anthropic 兼容），把外部 CLI（Claude Code / Cline / Codex 等）的请求
   翻译成 Kiro 请求并流式回吐。

凭据、模型发现、用量都读本机 Kiro CLI/IDE 已登录的 `~/.aws/sso/cache`，也支持插件自己
`$DSH_HOME/storages/kiro-proxy/accounts.json` 托管的多账号。

## 1. Kiro 线协议（wire）

请求（POST，JSON）：

```
{
  profileArn?: string,
  additionalModelRequestFields?: object,
  conversationState: {
    chatTriggerType: 'MANUAL',
    conversationId: string,              // uuid v4，可跨轮复用
    currentMessage: { userInputMessage: UserInputMessage },
    history?: HistoryEntry[]             // 严格 user/assistant 交替
  }
}
```

`UserInputMessage = { content, modelId, origin: 'AI_EDITOR', userInputMessageContext?: { tools?, toolResults? }, images? }`
`AssistantResponseMessage = { content, toolUses?: { toolUseId, name, input }[] }`

响应：`content-type: application/vnd.amazon.eventstream`，逐帧：

```
[4B totalLen][4B headerLen][4B preludeCRC][headers][payload JSON][4B messageCRC]
header = [1B nameLen][name][1B type=7][2B valueLen][value]
```

payload 事件（`headers[':event-type']` 或 `:exception-type`）：
`assistantResponseEvent{content}`、`reasoningContentEvent{text?,signature?,redactedContent?}`、
`toolUseEvent{toolUseId,name?,input?,stop?}`、`contextUsageEvent{contextUsagePercentage}`、
`meteringEvent{unit,unitPlural,usage}`、`metadataEvent{tokenUsage?,stopReason?,stopDetails?}`。

端点（按 authMethod 选）：

| authMethod | chat 端点 |
| --- | --- |
| `idc` / `external_idp` | `https://codewhisperer.<region>.amazonaws.com/generateAssistantResponse`（带 `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`） |
| 其他（builder-id / google / github / social / imported / api_key） | `https://q.<region>.amazonaws.com/generateAssistantResponse` |

公共头：`authorization: Bearer <accessToken>`、`content-type: application/json`、
`accept: application/vnd.amazon.eventstream`、`x-amzn-kiro-agent-mode: vibe`、
`user-agent` 与 `x-amz-user-agent` 均为 `aws-sdk-js/3.738.0 KiroIDE`（Kiro 按 UA 授权）、
`x-amzn-codewhisperer-optout: true`、`Amz-Sdk-Request: attempt=1; max=3`、
`Amz-Sdk-Invocation-Id: <uuid>`、`x-amzn-codewhisperer-machine-id: kiro-desktop`；
api_key 追加 `TokenType: API_KEY`，external_idp 追加 `TokenType: EXTERNAL_IDP`；
有 profileArn 时追加 `x-amzn-codewhisperer-profile-arn`。

## 2. 模块边界

```
index.js                Host 插件入口：Config、注册 adapter、挂 web 路由
lib/kiro-error.js       kiroError()/errorCode()/errorText()          [Lead]
lib/kiro-transport.js   post/get + CONNECT 代理 + JSON 帮助函数        [Lead]
lib/kiro-auth.js        凭据读取/刷新/多账号                           [Lead]
lib/kiro-client.js      KiroClient：models()/usage()/stream()/profile() [Lead]
lib/kiro-eventstream.js decodeFrames(stream) -> AsyncIterable<Frame>  [wire]
lib/kiro-serialize.js   Harness GenerateOptions -> WireRequest        [wire]
lib/kiro-openai.js      OpenAI chat.completions <-> Kiro              [translate]
lib/kiro-anthropic.js   Anthropic messages <-> Kiro                   [translate]
lib/adapter.js          LlmAdapter 子类                               [Lead]
lib/web.js              /v1/* 与 /kiro-proxy/v1/* 路由 + /kiro-proxy/api 状态 API [Lead]
client.js               Web UI：settings.section + conversation.input.right [ui]
```

## 3. wire 模块契约

`lib/kiro-eventstream.js`

```js
/** @typedef {{ headers: Record<string,string>, payload: Uint8Array }} WireFrame */
export async function* decodeFrames(stream /* AsyncIterable<Uint8Array> */, onActivity?: () => void): AsyncGenerator<WireFrame>
```
- 12 字节 prelude，CRC 不校验；`totalLength` 上限 16 MiB，否则 `MALFORMED_RESPONSE`。
- 流在帧中间结束 -> `STREAM_CLOSED`。
- 只用 `kiroError` 抛错。

`lib/kiro-serialize.js`

```js
export function serializeRequest(options, ctx)
// options: GenerateOptions（见下）, ctx: {
//   conversationId: string, modelId: string, profileArn?: string,
//   effort?: { schemaPath: 'output_config'|'reasoning', level: string },
//   maxTokensBounds?: {minimum:number, maximum:number},
//   toolNameMap?: (name:string)=>string,   // 可选，默认恒等
// }
// -> { body: WireRequest, toolNameMap: Map<string,string> }  // wire 名 -> harness 名
export function wireToolUseId(id: string): string
```
规则：
- 没有 system 槽：`options.system` 前置到最早一条 user 内容的开头。
- 最后一条 user 是 `currentMessage`，其余进 `history`；history 必须严格交替，
  缺失一侧用 `'Continue'`（user）/`'understood'`（assistant）补齐；合并连续同角色。
- 工具结果（`role: 'tool'`）挂到承载它的 user 轮 `userInputMessageContext.toolResults`；
  找不到对应 `toolUseId` 的结果降级成文本追加进 content。
- `content` 为字符串：text 块拼接、reasoning 块丢弃、image 块进 `images[]`
  （`{format:'png'|'jpeg'|'gif'|'webp', source:{bytes:<base64>}}`，由 ctx.images 提供
  base64；ctx 里没有就抛 `UNSUPPORTED_CONTENT`）。assistant 轮有 image 也抛。
- 工具名必须匹配 `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`，否则用
  `tool_${sha1(name).slice(0,12)}` 改名并记录到返回的 map 里；tool-call 的 id 走 `wireToolUseId`。
- history 条目数上限 198，超出把最旧的折叠成一条文本 user 轮（前缀 `[earlier conversation]\n`）。
- effort：`ctx.effort` 存在时写 `additionalModelRequestFields[ctx.effort.schemaPath] = { effort: level }`；
  再有 `options.maxTokens` 且 `ctx.maxTokensBounds` 存在时写 `max_tokens`（夹到 min/max 之间）。
- 不使用 `inferenceConfig`、`temperature`、`topP`、`stop`。

`GenerateOptions`（Host 侧）：
`{ provider, model, reasoningEffort?, messages: RequestMessage[], system?, tools?: ToolSchema[], temperature?, maxTokens?, stop?, signal? }`
`messages` 里元素 `{ role: 'user'|'assistant'|'tool'|'system'|'developer', content: ContentBlock[], id?, source?, toolCallId? }`，
`ContentBlock` 是 `{type:'text',text}` / `{type:'reasoning',text}` / `{type:'image',attachment}` /
`{type:'tool-call',id,name,arguments}` / `{type:'file',attachment}`。
`ToolSchema = { name, description, parameters }`。

## 4. translate 模块契约

两边都只需要 **纯函数**，不做 I/O：

`lib/kiro-openai.js`

```js
export function openAiToWire(body, ctx)
// body: OpenAI /v1/chat/completions 请求体
// ctx: { modelId, conversationId, profileArn?, systemPrefix?, effort?: {schemaPath,level},
//        maxTokensBounds?, maxTokensField? }
// -> { body: WireRequest, stream: boolean, model: string, toolNameMap: Map<string,string> }
export function newOpenAiState(init)          // { id, model, created }
export function wireToOpenAiChunk(evt, state)
// -> string | undefined    // 要写进 SSE 的 `data: {...}` 负载（不含 `data: ` 前缀与空行），或 undefined 表示不吐
export function wireToOpenAiResponse(state)
// -> 完整非流式响应对象（须在 wireFinish 之后调用）
export function wireFinish(state, stopReason)  // -> 收尾 chunk 文本
```

`lib/kiro-anthropic.js`

```js
export function anthropicToWire(body, ctx)
export function newAnthropicState(init)           // { id, model }
export function anthropicStart(state)             // -> message_start 负载
export function wireToAnthropicEvent(evt, state)  // -> { event, data } | undefined
export function anthropicStop(state, stopReason)  // -> [{ event, data }]（message_delta + message_stop）
export function anthropicResponse(state)          // -> 非流式 /v1/messages 响应对象
```

实现补充（Lead 已确认）：

- `ctx` 额外接受 `effort: { schemaPath, level }`、`maxTokensBounds`、`maxTokensField`
  —— effort 的字段名与 max_tokens 的字段名都由模型发现决定，写死会撞
  `additionalProperties: false`。
- `evt.kind === 'error'` 不抛错，转成各协议自己的 error 负载/帧：流已经开始，
  抛出去只能掐连接，客户端看到的是没有 finish_reason 的断流。
- `MODEL_CONTEXT_WINDOW_EXCEEDED` 除了映射成 `length` / `max_tokens`，还带一个
  `kiro: { code, message }` 附加字段说明真实原因。
- 已经流出工具块却收到 `END_TURN` 时强制报 `tool_calls` / `tool_use`：报 stop
  客户端不会执行工具，工具循环会静默死掉。
- `temperature` / `topP` / `stop` / `tool_choice` 一律不发（Kiro 无对应字段）。

事件归一化（两个 translate 模块收到的 `evt` 都由 `lib/kiro-client.js` 归一化后给出）：

```js
{ kind: 'text', text }
{ kind: 'reasoning', text }
{ kind: 'tool-start', id, name }
{ kind: 'tool-delta', id, argumentsDelta }
{ kind: 'tool-stop', id }
{ kind: 'usage', inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, contextPercentage? }
{ kind: 'stop', stopReason }   // END_TURN | TOOL_USE | MAX_TOKENS | MODEL_CONTEXT_WINDOW_EXCEEDED | CONTENT_FILTERED | PAUSE_TURN
{ kind: 'error', message, code }
```

## 5. 状态 API（UI 依赖）

Host 挂在 `webServer`：

- `GET  /kiro-proxy/api/status` -> `{ ok:true, value: Status }`
- `POST /kiro-proxy/api/refresh` -> 强制刷新模型与用量
- `POST /kiro-proxy/api/accounts/use` `{ id }` -> 切换活动账号
- `POST /kiro-proxy/api/accounts/import` `{ json | refreshToken | apiKey, label? }`
- `POST /kiro-proxy/api/accounts/remove` `{ id }`
- `POST /kiro-proxy/api/settings` `{ proxyUrl?, region?, profileArn?, maxContextWindow?, enabledModels? }`
- `POST /kiro-proxy/api/proxy-key` -> 生成/轮换本机反代 API key

`Status = {
  ok: true,
  accounts: [{ id, label, method, region, state: 'ready'|'refresh'|'signin', active }],
  activeAccountId: string | null,
  credentialSource: 'managed'|'kiro-cache'|'none',
  models: [{ id, name, contextWindow?, maxTokens?, inputModalities?, reasoningEfforts?, defaultEffort? }],
  enabledModels: string[],
  usage: { plan, rows: [{ label, used, limit, resetAt? }], fetchedAt } | null,
  proxy: { baseUrl, key: string, openaiBaseUrl, anthropicBaseUrl, enabled },
  config: { proxyUrl, region, profileArn, maxContextWindow },
  errors: string[],
}`

UI 只依赖 `status`，不直接碰 Host Service。

## 6. 命名与风格

- ESM，纯 JS（无构建步骤），`node --check` 必须通过。
- 中文注释，英文标识符。
- 不新增 npm 依赖；只用 `node:` 内置模块。
- 所有 Host 侧资源注册必须用 `ctx.effect` / `ctx.on` 并返回 disposer。
