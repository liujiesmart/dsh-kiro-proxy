# Changelog

All notable changes to dsh-kiro-proxy will be documented in this file.

## [0.2.0] - 2026-11-10

Adapts the plugin to **Kiro 1.4.121**. Upgrading Kiro broke chat completely:
every request failed with `403 FEATURE_NOT_SUPPORTED` / "This version of Kiro
is no longer supported. Please update to the latest version of Kiro to continue."

### Fixed

- **Chat now talks to the runtime plane.** Kiro 1.4.121 moved conversation
  traffic off the `q.<region>.amazonaws.com` and
  `codewhisperer.<region>.amazonaws.com` data planes onto its own
  `runtime.<region>.kiro.dev` plane, and the old planes now reject chat with
  `403 FEATURE_NOT_SUPPORTED` for every credential method. The plugin sends
  chat to `https://runtime.<region>.kiro.dev/generateAssistantResponse`. The
  wire protocol itself did not change: `generateAssistantResponse`, the
  `vnd.amazon.eventstream` framing, the event names, and the
  `x-amz-target` header are all identical, so only the host moved.
- **Profile discovery works again.** `ListAvailableProfiles` now answers
  `REQUEST_BODY_INVALID` when the body carries `maxResults`. The plugin sends an
  empty object, which is what the upgraded client sends. This mattered because
  chat on the runtime plane requires a `profileArn`: without rediscovering it,
  an Identity Center account could list models but could not send a single turn.
- **Removed debug instrumentation from the adapter.** Image-bearing turns used to
  write a full request dump to a hard-coded absolute path under the developer
  checkout and print to stderr. That is both a machine-specific path in shipped
  code and an unbounded write of conversation data, so it is gone.

### Unchanged on purpose

Catalog (`ListAvailableModels`), usage (`getUsageLimits`), and profile discovery
did **not** move: they still live on the `q` / `codewhisperer` data planes, still
split by auth method. Only chat migrated. The plugin keeps that split.

### Verified

- 14/14 offline suites pass (`node tests/run-all.mjs`).
- A live end-to-end check against a real Kiro 1.4.121 account covers the Harness
  adapter (text turn, tool-call turn), the OpenAI surface
  (`/v1/models`, `/v1/chat/completions`), and the Anthropic surface
  (`/v1/messages`): `node tests/live-1.4.121.mjs` -> 14/14 pass.

### Notes for maintainers

The upstream extension (`kiro.kiro-agent 1.1.787`) also carries a
`/v1/responses` (OpenAI Responses-shaped, SSE) chat path. It is gated behind a
feature flag (`AB_CREATE_RESPONSE_API` = `create_response`) and is therefore not
the path the released IDE uses by default. This release deliberately stays on
`generateAssistantResponse`, which is what the IDE actually calls today and
which the runtime plane still serves. If that flag ever becomes the default, the
SSE adapter at `GUs` in the extension bundle is the reference for the event
mapping.

## [0.1.10] - 2025-11-02

### Fixed
- **关键修复：`/v1/models` 端点缺失 `inputModalities` 字段**
  - 修复 `lib/web.js` 中 `/v1/models` OpenAI 兼容端点未返回 `inputModalities` 的问题
  - DSH 通过 `/v1/models` 获取模型列表，之前返回的模型对象缺少 `inputModalities` 字段
  - 导致即使 adapter 正确识别了图片能力，DSH 界面仍无法显示和使用图片功能
  - 现在 `/v1/models` 响应正确包含 `inputModalities: ['text', 'image']`

### Technical Details
- **问题根源**：`/v1/models` 端点（line 483-490）只返回 `id`, `object`, `created`, `owned_by`, `context_window`，遗漏了 `inputModalities`
- **修复方式**：添加 `...model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }` 到响应映射
- **影响范围**：所有通过 OpenAI 兼容接口使用 kiro-proxy 的场景（包括 DSH 主界面）

### Upgrade Instructions
**必须重启 DSH 才能使修复生效：**
1. 完全关闭 DeepSeek Harness（任务管理器杀进程）
2. 重新启动 DSH
3. 打开浏览器开发者工具，访问 `http://127.0.0.1:PORT/v1/models`
4. 验证 `claude-opus-5.5` 等模型对象包含 `inputModalities: ["text", "image"]`
5. 在 DSH 界面中测试图片上传

## [0.1.9] - 2025-11-02

### Fixed
- **模型图片能力识别增强**: 确保所有支持视觉的模型正确标记 `inputModalities: ['text', 'image']`
  - 强化 `adapter.js` 中的 `IMAGE_CAPABLE_PREFIXES` fallback 逻辑
  - 当 Kiro API 未返回 `supportedInputTypes` 时，自动基于模型 ID 前缀识别图片能力
  - 修复 `claude-opus-5.5` 等模型可能未正确标记图片支持的问题
  - 版本号更新以触发 DSH 模型缓存刷新

### Technical Details
- `resolveInputModalities()` 两级回退机制：
  1. 优先使用 Kiro API 返回的 `model.inputModalities`
  2. 回退到模式匹配：支持 `claude-`, `gpt-4`, `gpt-5`, `gemini-`, `glm-`, `deepseek-`, `minimax-`, `qwen` 等前缀
- 在 `listModels()` 和 `resolveModel()` 中都应用相同的 fallback 逻辑
- 新增 `test-image-support.mjs` 验证图片能力检测逻辑

### Upgrade Instructions
**升级后需要重启 DSH 以清除旧的模型缓存：**
1. 关闭 DeepSeek Harness
2. 重新启动 DSH
3. 在模型选择器中验证模型显示支持 "text, image"
4. 尝试在对话中上传图片

## [0.1.7] - 2025-01-31

### Fixed
- **图片支持修复**: 修复了 `adapter.js` 中的 `prepareImages` 函数，使其能够正确处理 DSH Harness 传递的图片数据
  - 之前只检查消息块内嵌的图片数据，导致通过 `options.images` 对象传递的图片无法被识别
  - 现在支持三种图片数据来源：
    1. `options.images` 为 Map 类型（直接返回）
    2. `options.images` 为普通对象（转换为 Map）
    3. 消息块中内嵌的图片数据（从 attachment 提取）
  - 修复了所有使用 kiro-proxy 发送图片时出现的 `UNSUPPORTED_CONTENT` 错误
  - 解决了 session-3b73c910 等 session 无法支持图片的问题

### Technical Details
- 问题根源：DSH Harness 将图片数据作为普通对象通过 `options.images` 传递，而非 Map
- 消息块中的 `attachment` 只包含 `attachmentId` 引用，不包含实际的 base64 数据
- `kiro-serialize.js` 的 `imagesOf` 函数需要完整的图片 Map 才能解析引用
- 修复后所有图片处理场景都能正常工作

### Added
- 新增 `tests/prepareImages-test.mjs` - prepareImages 函数的完整单元测试
- 新增 `tests/image-support.mjs` - 图片支持场景测试

## [0.1.6] - Previous Release

Initial stable release with Kiro provider and OpenAI/Anthropic reverse proxy support.
