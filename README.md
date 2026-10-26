# dsh-kiro-proxy

**English** | [中文](#中文说明)

Kiro (AWS CodeWhisperer / Amazon Q) as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) provider route, plus an OpenAI- and Anthropic-compatible reverse proxy in front of the same account.

No API key, no hand-edited `cordis.yml`: install the bundle and the `kiro-proxy` route appears. If Kiro IDE or the Kiro CLI is already signed in on this machine, chat works immediately.

This is an independent integration, not affiliated with or endorsed by AWS. Kiro is an Amazon trademark; see [NOTICE.md](NOTICE.md).

## Install

```sh
dsh plugin --profile <profile> add github:liujiesmart/dsh-kiro-proxy
dsh --profile <profile>
```

Or point the Harness Plugin Manager at a local checkout of this directory (a local install is a link, so edits apply on reload).

## What it does

1. **Provider route `kiro-proxy`** — pick a Kiro model in a session and the turn streams straight from Kiro: text, out-of-band reasoning, tool calls, token accounting.
2. **Reverse proxy** — `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` (Anthropic), `GET /v1/models`, so any CLI speaking one of those protocols reaches the same Kiro account.
3. **Settings → Kiro Proxy** — usage first, then accounts, model allowlist, proxy URL/key, connection settings.

## Credentials

Nothing is baked in. Priority order:

1. Accounts stored by this plugin (`$DSH_HOME/storages/kiro-proxy/accounts.json`)
2. Whatever Kiro IDE / CLI already signed in with (`~/.aws/sso/cache/kiro-auth-token.json`)

Kiro-owned files are read, never rewritten; a refreshed Kiro token stays in memory. Files this plugin writes are mode `0600`.

Seven ways to add an account, from **Settings → Kiro Proxy → 连接**:

| Method | What happens |
| --- | --- |
| AWS Builder ID | AWS OIDC device code; open the link, enter the code, approve |
| IAM Identity Center | Same device code against your instance: needs the portal URL (`https://<org>.awsapps.com/start`) and its region |
| Google / GitHub | Kiro's own social device code, approved on `app.kiro.dev` |
| Refresh token | Pasted token, validated locally; refreshes through Kiro's auth service |
| API key | Pasted `ksk_` key; sent with `TokenType: API_KEY` |
| External IdP | Pasted Microsoft Entra / external-IdP JSON; refreshes at its own endpoint |

The OIDC registration carries Kiro's own Identity Center issuer. Without it the AWS portal answers the device code with "We could not verify your sign-in credentials" — it is a fixed value, not your start URL.

| `authMethod` | Refresh endpoint | Chat surface |
| --- | --- | --- |
| `builder-id` | `oidc.<region>.amazonaws.com/token` + device registration | `q.<region>.amazonaws.com` |
| `idc` | same, at the Identity Center instance's region | `codewhisperer.<region>.amazonaws.com`, region taken from the discovered profile ARN |
| `google` / `github` / `social` | `prod.us-east-1.auth.desktop.kiro.dev/refreshToken` | `q.<region>.amazonaws.com` |
| `imported` | same as above | `q.<region>.amazonaws.com` |
| `api_key` | no refresh | `q.<region>.amazonaws.com` + `TokenType: API_KEY` |
| `external_idp` | its own token endpoint | `codewhisperer.<region>.amazonaws.com` + `TokenType: EXTERNAL_IDP` |

## Using it outside the Harness

The settings page shows the base URLs and the generated proxy key:

```bash
# OpenAI-compatible
curl http://127.0.0.1:PORT/v1/chat/completions \
  -H "authorization: Bearer kr-xxxx" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4.5","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic-compatible (Claude Code and friends)
ANTHROPIC_BASE_URL=http://127.0.0.1:PORT ANTHROPIC_API_KEY=kr-xxxx claude
```

The key is not enforced by default (the proxy listens on loopback). Set `requireProxyKey: true` before exposing the Harness beyond loopback.

## Configuration

`Settings → Kiro Proxy` writes `$DSH_HOME/storages/kiro-proxy/settings.json`. A profile row wins over the page, so a deployment can pin values:

```yaml
- id: kiro-proxy
  config:
    proxyUrl: http://127.0.0.1:1082
    region: us-east-1
    profileArn: arn:aws:codewhisperer:us-east-1:...:profile/...
    maxContextWindow: 300000
    enabledModels: [claude-sonnet-4.5, glm-5]
    requireProxyKey: true
    fallbackOnEmpty: true
    fallbackModels: [claude-sonnet-4.5, glm-5]
    maxConcurrency: 2
    retryAttempts: 3
    maxRequestChars: 320000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `proxyUrl` | direct | HTTP(S) `CONNECT` egress for every Kiro request. Kiro authorizes model families by egress. |
| `region` | token region | Selects `q.<region>` / `codewhisperer.<region>`. |
| `profileArn` | account default | CodeWhisperer profile; discovered with `ListAvailableProfiles` when absent. |
| `maxContextWindow` | `200000` | Capacity reported to the Harness. The catalog advertises 1M, but the data plane answers `Input is too long.`, so reporting 1M would stop the Harness from ever compacting. Raise it deliberately. |
| `enabledModels` | all | Filters the model picker **and** `/v1/models`. Requests for a disabled model still pass. |
| `requireProxyKey` | `false` | Enforce the `kr-…` key on the proxy surfaces. |
| `fallbackOnEmpty` | `true` | Try the next model when a model answers with an empty stream. |
| `fallbackModels` | built-in list | Candidate order for that fallback; only ids present in the account catalog are used. |
| `maxConcurrency` | `2` | In-flight request cap; the rest queue. |
| `retryAttempts` | `3` | Retry rounds across both data planes. |
| `maxRequestChars` | `320000` | Character budget for one request; the oldest turns are dropped and oversized tool results clipped. |
| `autoContinue` | `true` | Send one more `continue` turn when a stream produced reasoning but nothing visible. |
| `maxContinuations` | `2` | Upper bound on those automatic continuations. |

## Failure semantics (measured, not assumed)

**Throttling.** Kiro answers `Encountered unexpectedly high load…` in three shapes: HTTP 429, a `:exception-type` frame inside an HTTP 200, or a 5xx body. Each round tries both data planes (`q.*` and `codewhisperer.*` overload independently), remembers the plane that worked, and backs off — honouring `x-amzn-kiro-ratelimit-retry-after` — only when both failed. A stream is never replayed after content has been emitted.

**Empty responses.** Kiro sends no refusal text. For input a model will not execute it returns HTTP 200 with a single `contextUsageEvent` and zero content frames. Which models do that depends on both model and prompt:

| Behaviour | Models observed |
| --- | --- |
| silent refusal (empty stream) | `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-opus-5`, `gpt-5.6-sol`, `gpt-5.6-terra` |
| answers normally | `claude-sonnet-4.5`, `claude-opus-4.7`, `claude-sonnet-4.6`, `glm-5`, `deepseek-3.2`, `minimax-m2.5`, `claude-haiku-4.5`, `auto`, `gpt-5.6-luna`, `claude-opus-4.5`, `minimax-m2.1` |
| answers with a canned refusal | `claude-sonnet-5`, `claude-opus-4.8`, `claude-opus-4.6`, `qwen3-coder-next` |

An empty turn therefore triggers the fallback chain instead of failing the turn; only when every candidate is empty does it report `CONTENT_FILTERED` (non-retryable — resending the same prompt produces the same empty stream). The settings page shows the last fallback.

**Cut-off turns.** Sometimes a stream carries only reasoning and then ends with `END_TURN`/`PAUSE_TURN` — nothing visible, no tool call. Kiro's own client answers that with one more `continue` turn, so the plugin does the same (bounded, `autoContinue` + `maxContinuations`), instead of leaving the user to type "继续" themselves. The continuation is sent as `assistant: understood` + `human: continue` so the two user turns cannot merge into one.

**Oversized requests.** `Input is too long.` is a 400 that arrives with nothing but that sentence, and the 198-entry history cap does not prevent it: a single turn with dozens of huge tool results can push the payload into megabytes. The serializer therefore also enforces a character budget, dropping the oldest turn pairs first (alternation preserved, orphaned tool results degraded to text) and clipping individual tool results to 20k characters (head + tail, with a marker).

**Tool calls.** A tool call with arguments arrives as `start` → an `input: ""` frame → argument fragments → `stop`. That empty fragment carries the tool name, so treating it as a second `start` would produce two blocks for one `toolUseId` — and replaying them on the next step answers `400 Improperly formed request.` Blocks are therefore keyed by `toolUseId` and idempotent. Also, on tool-only turns Kiro sends **no `metadataEvent` at all** — four frames and nothing else. The stop reason is derived from what actually happened, and empty arguments are normalised to `{}` because both DSH and OpenAI clients `JSON.parse` them.

## Verified

Offline suites, run them all with `npm test` (`tests/run-all.mjs`); everything except the `live-*` probes runs without credentials or a Host:

```
wire            110 checks   translate       146 checks
adapter          49 checks   auth             54 checks
wire events       6 checks   retry/backoff    21 checks
model fallback   14 checks   request budget   13 checks
auto-continue    12 checks
proxy over HTTP  40 checks   host mount       32 checks
post-install     35 checks   web UI           78 checks
import integrity 21 checks
```

Live against a real Kiro account: 21 models discovered, plan and credit usage read, streaming text, native reasoning, a two-turn tool loop (`tool-calls` → `stop`), both proxy surfaces in streaming and non-streaming mode, automatic model fallback (~5.7 s for a turn the selected model refused), and an 8 MB-shaped history answered in ~7.9 s instead of `Input is too long.`.

## Known limits

- **Images** only have a seat on user turns; Kiro's `AssistantResponseMessage` and `ToolResultContentBlock` have none. A tool-produced image is hoisted onto the user turn carrying its result.
- **`temperature` / `topP` / `stop`** have no accepted placement (`additionalModelRequestFields` is `additionalProperties: false`), so they are not sent rather than pretended.
- **`tool_choice`** has no Kiro equivalent and is ignored.
- **Tool names** must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`; others are renamed with a recorded mapping.
- **SOCKS proxies** are not supported; only HTTP/HTTPS `CONNECT`.
- **Token counts** use provider-reported values where present; otherwise input is priced from `contextUsagePercentage × context window`, output is estimated from emitted characters, and the usage is marked `estimated: true`.

## Layout

```
index.js                 Host entry: config, adapter registration, web routes
lib/kiro-auth.js         credential read / refresh / multi-account store
lib/kiro-transport.js    HTTPS with CONNECT-proxy egress
lib/kiro-client.js       models, usage, profile ARN, multi-surface streaming
lib/kiro-eventstream.js  vnd.amazon.eventstream frame decoder
lib/kiro-serialize.js    Harness messages -> wire request (+ size budget)
lib/kiro-openai.js       OpenAI <-> Kiro
lib/kiro-anthropic.js    Anthropic <-> Kiro
lib/adapter.js           DSH LlmAdapter (structurally typed)
lib/web.js               reverse proxy + state API
client.js                settings page + composer quota chip
docs/CONTRACT.md         module contract
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

---

# 中文说明

把 Kiro（AWS CodeWhisperer / Amazon Q）接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，
并在同一份登录态上开一个 OpenAI / Anthropic 双协议反向代理。

不内置 API key、不需要手改 `cordis.yml`：装完 bundle 就有 `kiro-proxy` 路由。本机 Kiro IDE 或
Kiro CLI 登录过，装完就能直接对话。

本项目是独立集成，与 AWS 无关；Kiro 是 Amazon 的商标，详见 [NOTICE.md](NOTICE.md)。

## 安装

```sh
dsh plugin --profile <profile> add github:liujiesmart/dsh-kiro-proxy
dsh --profile <profile>
```

或在 Harness 的 Plugin Manager 里安装本目录（本地目录安装是 link，改代码即时生效）。

## 它做三件事

1. **provider 路由 `kiro-proxy`** —— 会话里选 Kiro 的模型，直接流式拿到文本、独立 reasoning、
   工具调用与 token 计量。
2. **本地反向代理** —— `POST /v1/chat/completions`（OpenAI）、`POST /v1/messages`（Anthropic）、
   `GET /v1/models`，任何只会说这两种协议的 CLI 都能用同一个账号。
3. **Settings → Kiro Proxy** —— 用量卡在最上，之后是账号管理、模型勾选、代理地址与 key、连接配置。

## 凭据

不内置任何凭据。优先级：

1. 插件自己存的账号（`$DSH_HOME/storages/kiro-proxy/accounts.json`）
2. 本机 Kiro IDE / CLI 已登录的 `~/.aws/sso/cache/kiro-auth-token.json`

Kiro 自己的文件只读不写；刷新出来的 token 只留在内存里。插件写出的文件是 `0600`。

**Settings → Kiro Proxy → 连接** 提供七种登录方式：

| 方式 | 过程 |
| --- | --- |
| AWS Builder ID | AWS OIDC 设备码：打开链接、输入验证码、批准 |
| IAM 身份中心 | 同样的设备码，但打到你的实例：需要门户 URL（`https://<org>.awsapps.com/start`）与实例区域 |
| Google / GitHub | Kiro 自己的社交设备码，在 `app.kiro.dev` 上确认 |
| Refresh token | 粘贴 token，本地校验；后续走 Kiro 的刷新服务 |
| API Key | 粘贴 `ksk_` 开头的 key；请求带 `TokenType: API_KEY` |
| External IdP | 粘贴 Microsoft Entra / 外部 IdP 的 JSON；在它自己的端点刷新 |

OIDC 注册固定带 Kiro 自己的身份中心 issuer。少了它，AWS 门户会对设备码回「无法验证您的登录凭证」
—— 那是固定值，不是你的起始 URL。

| `authMethod` | 刷新端点 | chat surface |
| --- | --- | --- |
| `builder-id` | `oidc.<region>.amazonaws.com/token` + 设备注册 | `q.<region>.amazonaws.com` |
| `idc` | 同上，打到身份中心实例所在区域 | `codewhisperer.<region>.amazonaws.com`，区域取自查到的 profile ARN |
| `google` / `github` / `social` | `prod.us-east-1.auth.desktop.kiro.dev/refreshToken` | `q.<region>.amazonaws.com` |
| `imported` | 同上 | `q.<region>.amazonaws.com` |
| `api_key` | 不刷新 | `q.<region>.amazonaws.com` + `TokenType: API_KEY` |
| `external_idp` | 自己的 token endpoint | `codewhisperer.<region>.amazonaws.com` + `TokenType: EXTERNAL_IDP` |

## 在 Harness 之外使用

设置页会给出 base URL 与生成的 key：

```bash
# OpenAI 兼容
curl http://127.0.0.1:PORT/v1/chat/completions \
  -H "authorization: Bearer kr-xxxx" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4.5","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic 兼容（Claude Code 等）
ANTHROPIC_BASE_URL=http://127.0.0.1:PORT ANTHROPIC_API_KEY=kr-xxxx claude
```

默认不校验 key（只监听本机）。把 Harness 暴露到非 loopback 之前，先打开 `requireProxyKey: true`。

## 配置

`Settings → Kiro Proxy` 写入 `$DSH_HOME/storages/kiro-proxy/settings.json`；profile 的 row 优先级更高，
所以部署可以钉住配置：

```yaml
- id: kiro-proxy
  config:
    proxyUrl: http://127.0.0.1:1082
    region: us-east-1
    profileArn: arn:aws:codewhisperer:us-east-1:...:profile/...
    maxContextWindow: 300000
    enabledModels: [claude-sonnet-4.5, glm-5]
    requireProxyKey: true
    fallbackOnEmpty: true
    fallbackModels: [claude-sonnet-4.5, glm-5]
    maxConcurrency: 2
    retryAttempts: 3
    maxRequestChars: 320000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `proxyUrl` | 直连 | 每个 Kiro 请求的 HTTP(S) `CONNECT` 出口；Kiro 按出口授权模型族。 |
| `region` | token 里的 region | 选 `q.<region>` / `codewhisperer.<region>`。 |
| `profileArn` | 账号默认 | 缺省时用 `ListAvailableProfiles` 自己发现。 |
| `maxContextWindow` | `200000` | 上报给 Harness 的上下文容量。目录里报 1M，但数据面对长报文回 `Input is too long.`，报满 1M 等于让 Harness 永不压缩；要放开请显式配置。 |
| `enabledModels` | 全部 | 同时过滤模型选择器与 `/v1/models`；**请求被禁用的模型仍然放行**。 |
| `requireProxyKey` | `false` | 反代是否强制校验 `kr-…` key。 |
| `fallbackOnEmpty` | `true` | 模型回空流时是否换下一个模型。 |
| `fallbackModels` | 内置表 | 换模型的候选顺序；只在账号目录里存在的才用。 |
| `maxConcurrency` | `2` | 同时在飞的请求数，其余排队。 |
| `retryAttempts` | `3` | 跨两个数据面的重试轮数。 |
| `maxRequestChars` | `320000` | 单次请求的字符预算；超出时先丢最旧的整轮，再裁剪超长工具结果。 |
| `autoContinue` | `true` | 只有 reasoning、没有可见内容时，自动再发一轮 `continue`。 |
| `maxContinuations` | `2` | 自动续写的次数上限。 |

## 失败语义（全部来自实测）

**节流。** Kiro 会用三种形态回 `Encountered unexpectedly high load…`：HTTP 429、HTTP 200 里的
`:exception-type` 帧、或 5xx body。每一轮都会把两个数据面都试一遍（`q.*` 与 `codewhisperer.*`
独立过载），记住能用的那个面；只有两个面都失败才按 `x-amzn-kiro-ratelimit-retry-after` 退避。
已经吐给调用方的流绝不重放。

**空响应。** Kiro 不返回拒绝文本：对不愿执行的输入，它回 HTTP 200 + 单个 `contextUsageEvent`，
零内容帧。哪些模型会这样，既看模型也看提示词：

| 行为 | 实测模型 |
| --- | --- |
| 静默拒答（空流） | `claude-opus-5.5`、`claude-sonnet-5.5`、`claude-opus-5`、`gpt-5.6-sol`、`gpt-5.6-terra` |
| 正常作答 | `claude-sonnet-4.5`、`claude-opus-4.7`、`claude-sonnet-4.6`、`glm-5`、`deepseek-3.2`、`minimax-m2.5`、`claude-haiku-4.5`、`auto`、`gpt-5.6-luna`、`claude-opus-4.5`、`minimax-m2.1` |
| 作答但内容是固定拒绝句 | `claude-sonnet-5`、`claude-opus-4.8`、`claude-opus-4.6`、`qwen3-coder-next` |

所以空回合会触发换模型，而不是判死整轮；只有所有候选都空才报 `CONTENT_FILTERED`
（不可重试——同一份提示词重发还是空流）。设置页会显示最近一次自动换模型。

**回合被截断。** 有时一条流只有 reasoning，然后以 `END_TURN`/`PAUSE_TURN` 收尾 —— 没有可见正文、也没有工具调用。Kiro 自己的客户端对这种情况会补一轮 `continue`，插件照做（有上限，`autoContinue` + `maxContinuations`），而不是让你手动输入"继续"。续写按 `assistant: understood` + `human: continue` 发，避免两条 user 轮被合并成一条。

**超长请求。** `Input is too long.` 是一个只有这句话的 400，而 198 条历史上限管不住它：
一个回合里几十条巨型工具结果就能把报文推到几 MB。所以序列化器还按字符兜底——先丢最旧的整轮
（保持交替，悬空的工具结果降级为文本），再把单条工具结果裁到 2 万字符（保留头尾并加标记）。

**工具调用。** 带参数的工具调用在线上是 `开始` → 一帧 `input: ""` → 参数增量 → `stop`。那一帧空片段带着工具名，若被当成"又一次开始"就会给同一个 `toolUseId` 产出两个块 —— 下一步回灌时服务端回 `400 Improperly formed request.`。所以工具块按 `toolUseId` 幂等。另外，只调工具、没有正文的回合**完全不发 `metadataEvent`**
（整条流四帧）。所以结束原因是按"究竟发生了什么"推导的；空参数会补成 `{}`，因为 DSH 与
OpenAI 客户端都会对它做 `JSON.parse`。

## 验证

离线套件（`npm test` 一次跑完；除 `live-*` 探针外都不需要凭据，也不需要 Host）：

```
wire            110 项    translate       146 项
adapter          49 项    auth             54 项
wire events       6 项    retry/backoff    21 项
model fallback   14 项    request budget   13 项
auto-continue    12 项
proxy over HTTP  40 项    host mount       32 项
post-install     35 项    web UI           78 项
import integrity 21 项
```

真实账号上验证过：21 个模型发现、计划与额度读取、流式文本、原生 reasoning、两轮工具循环
（`tool-calls` → `stop`）、OpenAI 与 Anthropic 两个面的流式与非流式、自动换模型
（被拒的那一轮约 5.7s 拿到回答）、以及 8MB 形状的历史在约 7.9s 内正常作答而不是
`Input is too long.`。

## 已知边界

- **图片**只在 user 轮有座位；`AssistantResponseMessage` 与 `ToolResultContentBlock` 都没有。
  工具产出的图片会被提升到承载结果的 user 轮。
- **`temperature` / `topP` / `stop`** 没有合法位置（`additionalModelRequestFields` 是
  `additionalProperties: false`），所以不发，而不是假装发过。
- **`tool_choice`** 无对应字段，忽略。
- **工具名**必须匹配 `^[A-Za-z][A-Za-z0-9_]{0,63}$`，否则改名并记映射。
- **SOCKS 代理**不支持，只支持 HTTP/HTTPS `CONNECT`。
- **token 计数**优先用 provider 上报值；缺失时输入侧按 `contextUsagePercentage × 上下文窗口`
  定价、输出侧按字符数估算，并标 `estimated: true`。

## 目录

```
index.js                 Host 入口：配置、注册 adapter、挂 web 路由
lib/kiro-auth.js         凭据读取 / 刷新 / 多账号
lib/kiro-transport.js    HTTPS + CONNECT 代理
lib/kiro-client.js       模型、用量、profile ARN、多数据面流
lib/kiro-eventstream.js  vnd.amazon.eventstream 帧解码
lib/kiro-serialize.js    Harness 消息 -> wire 请求（含体积预算）
lib/kiro-openai.js       OpenAI <-> Kiro
lib/kiro-anthropic.js    Anthropic <-> Kiro
lib/adapter.js           DSH LlmAdapter（结构化类型）
lib/web.js               反代 + 状态 API
client.js                设置页 + 输入区额度徽标
docs/CONTRACT.md         模块契约
```

## 许可

MIT。详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
