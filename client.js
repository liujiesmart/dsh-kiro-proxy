/**
 * dsh-kiro-proxy — Harness Web UI 客户端模块。
 *
 * 两个座位（slot）：
 * - `settings.section`：完整的 Kiro Proxy 设置页，版式对齐 dsh-kiro 的 Settings → Kiro：
 *   标题 + 刷新、账号卡、登录流程（选择方式 → 填表 → 验证码 → 失败重来）、模型卡、
 *   用量卡、代理卡、连接配置卡、错误列表。单列、最大宽度 840px。
 * - `conversation.input.right`：输入框右侧的配额徽标，只显示“最紧那一行”的剩余比例。
 *
 * 设计约束（为什么这么写）：
 * - 唯一数据来源是 Host 的 `/kiro-proxy/api/*`（见 docs/CONTRACT.md 第 5 节）。
 *   UI 不碰 Host Service、不读别人的 DOM，所以宿主换内部实现时这里不用改。
 * - 无构建、无 npm 依赖：只用 `require('react')` 拿宿主的 React 实例，
 *   避免页面里出现第二份 React。
 * - 所有副作用（样式表）都走 `ctx.effect` 并返回 disposer，插件卸载/热重载后不留孤儿节点。
 * - 所有 fetch 失败都渲染成一行错误文字：设置页不该因为一次网络抖动整块白屏。
 * - 登录流程不用 overlay 弹层，而是账号卡下面的一块面板：设置区本来就窄，
 *   弹层会挡住用户正在核对的账号列表，而验证码恰恰要和账号信息一起看。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kiro-proxy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    // 徽标要订阅会话的模型选择（一个外部 store）；老版本 React 没有
    // useSyncExternalStore 时退化成 useState + 订阅，语义相同。
    function subscribeWithState(subscribe, getSnapshot) {
      const [snapshot, setSnapshot] = useState(getSnapshot)
      useEffect(() => {
        const sync = () => setSnapshot(getSnapshot())
        sync()
        return subscribe(sync)
      }, [subscribe, getSnapshot])
      return snapshot
    }
    const useStoreSnapshot = useSyncExternalStore instanceof Function ? useSyncExternalStore : subscribeWithState
    /** 本插件注册的 provider 路由；只有会话选中它时才显示用量。 */
    const PROVIDER = 'kiro-proxy'

    /** Host 侧状态 API 前缀（lib/web.js 把 /kiro-proxy/api/* 挂在 webServer 上）。 */
    const API = '/kiro-proxy/api'
    /** locale 命名空间，必须等于包名，宿主按命名空间合并/回退。 */
    const NS = 'dsh-kiro-proxy'
    /** 样式节点 id：幂等注入的钥匙，也是卸载时精确移除的句柄。 */
    const STYLE_ID = 'dsh-kiro-proxy-style'

    /** 登录表单的空白初值。整体替换而不是就地改写，避免跨方法串数据。 */
    const EMPTY_CONNECT_FIELDS = { startUrl: '', region: '', label: '', token: '', key: '', json: '' }

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 两份字典都注册给宿主：宿主语言切换时由 locale 服务挑，插件不自己判断语言。
    const en = {
      title: 'Kiro Proxy',
      description: 'Accounts, models, quota and the OpenAI / Anthropic proxy in front of Kiro.',
      loading: 'Loading…',
      refresh: 'Refresh',
      failed: 'Request failed',
      unknown: 'unknown',
      copyFailed: 'Copy failed',
      copied: 'Copied',
      save: 'Save',
      saved: 'Saved',
      working: 'Working…',

      accounts: 'Accounts',
      noAccounts: 'No stored account. Chat uses the Kiro IDE / CLI sign-in.',
      active: 'Active',
      use: 'Use',
      remove: 'Remove',
      removeConfirm: 'Remove this account from dsh-kiro-proxy?',
      signOutAll: 'Sign out all',
      credentialSource: 'Credential source',
      sourceManaged: 'Managed by dsh-kiro-proxy',
      sourceKiroCache: 'Kiro IDE / CLI sign-in',
      sourceNone: 'Not signed in',
      signedInAs: 'Signed in as',
      stateReady: 'Ready',
      stateRefresh: 'Refreshes on next use',
      stateSignin: 'Needs sign-in',

      connect: 'Connect',
      connectTitle: 'Add account',
      chooseMethod: 'Choose a sign-in method',
      recommended: 'Recommended',
      close: 'Close',
      back: 'Back',
      startLogin: 'Start sign-in',
      saveImport: 'Save',
      pendingTitle: 'Waiting for authorization',
      errorTitle: 'Sign-in failed',
      code: 'Code',
      openLoginPage: 'Open sign-in page',
      cancel: 'Cancel',
      waiting: 'Waiting for approval…',
      restart: 'Start over',
      connectDone: 'Signed in. The new account is now selected.',
      methodBuilderId: 'AWS Builder ID',
      methodBuilderIdDesc: 'Personal AWS account. Approves this browser on the AWS device page.',
      methodIdc: 'IAM Identity Center',
      methodIdcDesc: 'Organization access portal. Needs the start URL and the Identity Center region.',
      methodGoogle: 'Google',
      methodGoogleDesc: 'Sign in with the Google account already linked to Kiro.',
      methodGithub: 'GitHub',
      methodGithubDesc: 'Sign in with the GitHub account already linked to Kiro.',
      methodRefreshToken: 'Import refresh token',
      methodRefreshTokenDesc: 'Paste a Kiro refresh token copied from another machine.',
      methodApiKey: 'Import API key',
      methodApiKeyDesc: 'Paste a Kiro API key; it is sent as a bearer token.',
      methodExternalIdp: 'Microsoft Entra / external IdP',
      methodExternalIdpDesc: 'Paste the external IdP credential JSON.',
      label: 'Label (optional)',
      startUrl: 'Start URL',
      regionPlain: 'Region',
      token: 'Refresh token',
      jsonInput: 'Credential JSON',
      idcMissing: 'Enter both the start URL and the region.',
      tokenRequired: 'Paste the refresh token first.',
      keyRequired: 'Paste the API key first.',
      jsonRequired: 'Paste the credential JSON first.',

      models: 'Models',
      modelsHint: 'Only checked models are offered to sessions and to the proxy.',
      noModels: 'No model available yet.',
      selected: 'selected',
      selectAll: 'Select all',
      selectNone: 'Clear',
      contextWindow: 'context',
      maxTokens: 'max out',

      usage: 'Usage',
      refreshUsage: 'Refresh usage',
      noUsage: 'No usage reading yet.',
      resets: 'resets',
      updated: 'updated',

      proxy: 'Proxy',
      proxyUnavailable: 'Proxy information unavailable.',
      openaiBase: 'OpenAI base URL',
      anthropicBase: 'Anthropic base URL',
      apiKey: 'API key',
      copy: 'Copy',
      rotateKey: 'Rotate key',

      connection: 'Connection',
      proxyUrl: 'Proxy URL (optional)',
      region: 'AWS region (optional)',
      profileArn: 'Profile ARN (optional)',
      maxContextWindow: 'Max context window (optional)',
      maxContextHint: 'Empty follows each model. A smaller number spends fewer tokens per turn.',
      maxContextInvalid: 'Enter a positive integer token count, or leave it empty.',

      errors: 'Errors',
      quotaTitle: 'Kiro quota',
      quotaLeft: '{percent}% left',
    }

    const zh = {
      title: 'Kiro Proxy',
      description: '托管 Kiro 账号、选择模型、查看用量，并提供 OpenAI / Anthropic 反向代理。',
      loading: '加载中…',
      refresh: '刷新',
      failed: '请求失败',
      unknown: '未知',
      copyFailed: '复制失败',
      copied: '已复制',
      save: '保存',
      saved: '已保存',
      working: '处理中…',

      accounts: '账号',
      noAccounts: '没有托管账号，当前使用 Kiro IDE / CLI 的登录凭据。',
      active: '当前',
      use: '使用',
      remove: '删除',
      removeConfirm: '从 dsh-kiro-proxy 中删除这个账号？',
      signOutAll: '全部退出',
      credentialSource: '凭据来源',
      sourceManaged: '由 dsh-kiro-proxy 托管',
      sourceKiroCache: 'Kiro IDE / CLI 登录',
      sourceNone: '未登录',
      signedInAs: '已登录为',
      stateReady: '可用',
      stateRefresh: '下次使用时刷新',
      stateSignin: '需要登录',

      connect: '连接',
      connectTitle: '添加账号',
      chooseMethod: '选择登录方式',
      recommended: '推荐',
      close: '关闭',
      back: '返回',
      startLogin: '开始登录',
      saveImport: '保存',
      pendingTitle: '等待授权',
      errorTitle: '登录失败',
      code: '验证码',
      openLoginPage: '打开登录页',
      cancel: '取消',
      waiting: '等待授权…',
      restart: '重新开始',
      connectDone: '登录成功，新账号已设为当前账号。',
      methodBuilderId: 'AWS Builder ID',
      methodBuilderIdDesc: '个人 AWS 账号，在 AWS 设备页批准本浏览器即可。',
      methodIdc: 'IAM 身份中心',
      methodIdcDesc: '组织访问门户。需要填写起始 URL 与身份中心实例所在区域。',
      methodGoogle: 'Google',
      methodGoogleDesc: '使用已绑定 Kiro 的 Google 账号登录。',
      methodGithub: 'GitHub',
      methodGithubDesc: '使用已绑定 Kiro 的 GitHub 账号登录。',
      methodRefreshToken: '导入 refresh token',
      methodRefreshTokenDesc: '粘贴从其他机器复制来的 Kiro refresh token。',
      methodApiKey: '导入 API Key',
      methodApiKeyDesc: '粘贴 Kiro API Key，作为 bearer token 使用。',
      methodExternalIdp: 'Microsoft Entra / 外部 IdP',
      methodExternalIdpDesc: '粘贴外部 IdP 的凭据 JSON。',
      label: '标签（可选）',
      startUrl: '起始 URL',
      regionPlain: '区域',
      token: 'Refresh token',
      jsonInput: '凭据 JSON',
      idcMissing: '请同时填写起始 URL 和区域。',
      tokenRequired: '请先粘贴 refresh token。',
      keyRequired: '请先粘贴 API Key。',
      jsonRequired: '请先粘贴凭据 JSON。',

      models: '模型',
      modelsHint: '只有勾选的模型会提供给会话和反向代理。',
      noModels: '暂时没有可用模型。',
      selected: '已选',
      selectAll: '全选',
      selectNone: '全不选',
      contextWindow: '上下文',
      maxTokens: '最大输出',

      usage: '用量',
      refreshUsage: '刷新用量',
      noUsage: '还没有用量数据。',
      resets: '重置',
      updated: '更新于',

      proxy: '代理',
      proxyUnavailable: '暂时读不到代理信息。',
      openaiBase: 'OpenAI Base URL',
      anthropicBase: 'Anthropic Base URL',
      apiKey: 'API Key',
      copy: '复制',
      rotateKey: '轮换 Key',

      connection: '连接配置',
      proxyUrl: '代理地址（可选）',
      region: 'AWS 区域（可选）',
      profileArn: 'Profile ARN（可选）',
      maxContextWindow: '最大上下文窗口（可选）',
      maxContextHint: '留空则跟随各模型；数值越小，每轮消耗的 token 越少。',
      maxContextInvalid: '请输入正整数 token 数，或留空。',

      errors: '错误',
      quotaTitle: 'Kiro 配额',
      quotaLeft: '剩余 {percent}%',
    }

    /**
     * 文案函数。
     *
     * 优先用宿主的 `locale.bind(NS)`：它会跟随用户在设置里切换语言。
     * 宿主没有 bind（或 bind 只回吐裸 key）时退回本地字典 ——
     * 一个可选服务缺失不该让整页显示成 key 名。
     */
    function translator(ctx) {
      const bound = ctx && ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined
      return (key) => {
        // 宿主把未翻译的 key 原样（或带命名空间）回吐，这两种都当作“没有译文”。
        const hosted = bound ? bound(key) : undefined
        const untranslated = !hosted || hosted === key || hosted === NS + '.' + key
        if (!untranslated) return hosted
        const active = ctx && ctx.locale && typeof ctx.locale.getLocale === 'function'
          ? ctx.locale.getLocale()?.active
          : (typeof navigator === 'undefined' ? undefined : navigator.language)
        // 中文是默认：只有明确是英文环境才切 en，其余（含拿不到语言）一律中文，
        // 免得一个缺失的 locale 服务把中文用户丢进英文界面。
        const isEnglish = typeof active === 'string' && active.toLowerCase().startsWith('en')
        const dictionary = isEnglish ? en : zh
        return dictionary[key] ?? zh[key] ?? en[key] ?? key
      }
    }

    /** 任何被 throw 出来的东西都折成一行可读文字。 */
    function messageOf(cause) {
      return cause && cause.message ? cause.message : String(cause)
    }

    // ── 网络 ────────────────────────────────────────────────────────────────

    /**
     * 调一次状态 API，返回完整响应体 `{ ok, value, status? }`。
     *
     * 统一在这里把“HTTP 失败”和“业务失败（ok:false）”折成同一个 Error，
     * 调用方只需要 try/catch 一次就能拿到一行可读的错误文字。
     */
    async function request(path, options) {
      // 调用方的 options 覆盖默认头（与展开顺序一致：后者优先）。
      const init = Object.assign({ headers: { 'content-type': 'application/json' } }, options)
      const response = await fetch(API + path, init)
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body === undefined || body === null || body.ok === false) {
        const detail = body && typeof body.error === 'string' && body.error.length > 0
          ? body.error
          : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return body
    }

    /**
     * 从写类接口的返回体里取出最新 status。
     *
     * Host 的几个端点返回形状并不统一（`{value: Status}` / `{value, status}` /
     * `{value: {account, status}}`），这里按顺序认一遍，都不像才再读一次 ——
     * 少一次往返，也少一个“页面短暂显示旧数据”的窗口。
     */
    async function valueOrStatus(body) {
      const looksLikeStatus = value => Boolean(value)
        && typeof value === 'object'
        && (Array.isArray(value.accounts) || Array.isArray(value.models) || typeof value.ok === 'boolean')
      if (body && looksLikeStatus(body.status)) return body.status
      if (body && looksLikeStatus(body.value)) return body.value
      if (body && body.value && looksLikeStatus(body.value.status)) return body.value.status
      const next = await request('/status')
      return next.value
    }

    // ── 格式化 ──────────────────────────────────────────────────────────────

    /** 按运行环境的默认 locale 格式化；非有限数显示破折号。 */
    function formatNumber(value, fractionDigits) {
      if (!Number.isFinite(value)) return '—'
      const locale = undefined
      return new Intl.NumberFormat(locale, { maximumFractionDigits: fractionDigits }).format(value)
    }

    function formatAmount(value) {
      return formatNumber(value, 2)
    }

    function formatPercent(value, digits) {
      return formatNumber(value, digits === undefined || digits === null ? 1 : digits)
    }

    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return ''
      if (value >= 1000000) return `${formatPercent(value / 1000000, 2)}M`
      if (value >= 1000) return `${formatPercent(value / 1000, 1)}K`
      return String(value)
    }

    function formatDate(value) {
      if (!Number.isFinite(value)) return ''
      try {
        return new Date(value).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })
      } catch {
        return ''
      }
    }

    /**
     * 一行用量的剩余比例。
     * 上限未知或为 0 时返回 undefined：这种行不参与“最紧”的比较。
     */
    function remainingPercent(row) {
      const used = Number(row && row.used)
      const limit = Number(row && row.limit)
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return undefined
      return Math.max(0, Math.min(100, (1 - used / limit) * 100))
    }

    /** 最紧的一行：剩余比例最小，也就是决定下一轮会不会被拒的那一行。 */
    function tightestRow(usage) {
      const rows = usage && Array.isArray(usage.rows) ? usage.rows : []
      const scored = rows
        .map(row => ({ row, left: remainingPercent(row) }))
        .filter(entry => entry.left !== undefined)
      if (scored.length === 0) return undefined
      return scored.reduce((worst, entry) => (entry.left < worst.left ? entry : worst))
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 全部使用宿主的 --dsw-alias-* 主题 token，并带 fallback：
    // token 缺失（旧宿主/第三方主题）时仍有可读的对比度。
    const STYLES = `
.dshkp-wrap{box-sizing:border-box;width:100%;max-width:840px;padding:0 0 28px;color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;line-height:20px}
.dshkp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dshkp-title{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.dshkp-desc{margin:6px 0 16px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-card{margin:0 0 12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#1b1b1f))}
.dshkp-connect{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18))}
.dshkp-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;min-height:24px}
.dshkp-card-title{font-size:13px;font-weight:650;letter-spacing:.01em}
.dshkp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dshkp-btn{padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshkp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.dshkp-btn:disabled{opacity:.5;cursor:not-allowed}
.dshkp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f46e5));color:var(--dsw-alias-label-primary-inverted,#fff)}
.dshkp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4338ca))}
.dshkp-danger{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshkp-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.12))}
.dshkp-error{margin:0 0 12px;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-secondary,rgba(239,68,68,.45));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.1));color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;word-break:break-word}
.dshkp-notice{margin:0 0 12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:9px;background:var(--dsw-alias-fill-l1,rgba(139,92,246,.12));color:var(--dsw-alias-label-primary,#f9fafb);font-size:12px}
.dshkp-empty{padding:6px 0;color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:12px}
.dshkp-status-line{display:flex;align-items:center;gap:6px;margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9ca3af)}
.dshkp-dot-on{background:var(--dsw-alias-brand-primary,#8b5cf6)}
.dshkp-list{display:grid;gap:8px}
.dshkp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));border-radius:9px}
.dshkp-row-active{border-color:var(--dsw-alias-brand-primary,rgba(99,102,241,.7));background:var(--dsw-alias-fill-l1,rgba(99,102,241,.1))}
.dshkp-row-main{min-width:0;display:grid;gap:3px}
.dshkp-row-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f9fafb);word-break:break-all}
.dshkp-row-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-tag{padding:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-badge{padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600}
.dshkp-badge-active{background:var(--dsw-alias-fill-l1,rgba(139,92,246,.16));color:var(--dsw-alias-brand-primary,#a78bfa)}
.dshkp-state{display:inline-flex;align-items:center;gap:5px}
.dshkp-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9ca3af)}
.dshkp-state-ready::before{background:var(--dsw-alias-brand-primary,#8b5cf6)}
.dshkp-state-refresh::before{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dshkp-state-signin::before{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dshkp-chooser-copy{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-methods{display:grid;gap:8px}
.dshkp-method{display:flex;align-items:flex-start;gap:11px;width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;background:transparent;color:inherit;font-family:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
.dshkp-method:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,rgba(99,102,241,.7));background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dshkp-method:disabled{cursor:not-allowed;opacity:.55}
.dshkp-method-icon{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:9px;background:var(--dsw-alias-fill-l2,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:10.5px;font-weight:700;letter-spacing:.02em}
.dshkp-method-main{min-width:0;flex:1;display:grid;gap:3px}
.dshkp-method-title{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-primary,#f9fafb)}
.dshkp-method-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-chevron{align-self:center;color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:18px;line-height:1}
.dshkp-step-head{display:flex;align-items:center;gap:9px;margin-bottom:12px}
.dshkp-back{padding:4px 8px}
.dshkp-step-title{font-size:13px;font-weight:650}
.dshkp-code{margin:0 0 10px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.2))}
.dshkp-code-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshkp-code-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-code-value{padding:2px 10px;border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(255,255,255,.08));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;font-weight:650;letter-spacing:.14em;color:var(--dsw-alias-label-primary,#f9fafb)}
.dshkp-working{font-size:12px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-close{padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#adb2b8);font-family:inherit;font-size:17px;line-height:20px;cursor:pointer}
.dshkp-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#f9fafb)}
.dshkp-link-btn{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);font-family:inherit;font-size:11.5px;line-height:18px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.dshkp-link-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#f9fafb)}
.dshkp-link-btn:disabled{opacity:.5;cursor:not-allowed}
.dshkp-model{display:flex;align-items:flex-start;gap:9px;padding:6px 8px;border-radius:8px;cursor:pointer}
.dshkp-model:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.dshkp-model-off{opacity:.55}
.dshkp-check{margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary,#4f46e5);flex:none}
.dshkp-model-text{min-width:0;display:grid;gap:2px}
.dshkp-model-name{font-size:12.5px;color:var(--dsw-alias-label-primary,#f9fafb)}
.dshkp-model-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8);word-break:break-all}
.dshkp-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-usage-plan{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.dshkp-usage-plan strong{font-size:15px;font-weight:650}
.dshkp-usage-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.dshkp-usage-plan+.dshkp-usage-row{border-top:0}
.dshkp-usage-label{font-size:12.5px;color:var(--dsw-alias-label-primary,#f9fafb)}
.dshkp-usage-amount{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#cfd3d6);text-align:right}
.dshkp-usage-reset{grid-column:1/-1;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-usage-bar{grid-column:1/-1;height:5px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(255,255,255,.1));overflow:hidden}
.dshkp-usage-bar-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-label-secondary,#cfd3d6);transition:width .2s ease}
.dshkp-usage-low .dshkp-usage-bar-fill{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dshkp-usage-critical .dshkp-usage-bar-fill{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dshkp-usage-left{grid-column:1/-1;font-size:11.5px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-usage-low .dshkp-usage-left{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dshkp-usage-critical .dshkp-usage-left{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshkp-kv{display:grid;gap:8px}
.dshkp-kv-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center}
.dshkp-kv-key{font-size:12px;color:var(--dsw-alias-label-secondary,#cfd3d6);white-space:nowrap}
.dshkp-kv-value{min-width:0;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));border-radius:7px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.25));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshkp-form{display:grid;gap:10px}
.dshkp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dshkp-field{display:grid;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-field-wide{grid-column:1/-1}
.dshkp-input{box-sizing:border-box;width:100%;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#f9fafb);font-family:inherit;font-size:12.5px;line-height:18px}
.dshkp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f46e5)}
.dshkp-textarea{min-height:74px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dshkp-hint{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
a.dshkp-btn{text-decoration:none;display:inline-block}
.dshkp-errors{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-state-error-primary,#ef4444);word-break:break-word}
.dshkp-quota{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);font-family:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dshkp-quota:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.dshkp-quota:disabled{cursor:progress;opacity:.7}
.dshkp-quota-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#8b5cf6);flex:none}
.dshkp-quota-low{color:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:var(--dsw-alias-state-warn-secondary,rgba(245,158,11,.45))}
.dshkp-quota-low .dshkp-quota-dot{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dshkp-quota-critical{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:var(--dsw-alias-state-error-secondary,rgba(239,68,68,.5))}
.dshkp-quota-critical .dshkp-quota-dot{background:var(--dsw-alias-state-error-primary,#ef4444)}
`

    /**
     * 注入本插件唯一的样式表，返回 disposer。
     *
     * 幂等：已经存在就直接返回空 disposer，重复 apply 不会叠出第二份 CSS。
     * 只用 document.head，不往 body 追加节点（页面结构归宿主）。
     */
    function installStyle() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      if (document.getElementById(STYLE_ID)) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLES
      document.head.appendChild(style)
      return () => {
        // 只移除自己创建的节点；万一宿主已经重排过 DOM，remove 是安全的空操作。
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    // ── 设置页 ──────────────────────────────────────────────────────────────

    /**
     * 完整的设置页。
     *
     * 一个 `status` 就是全部真相：所有操作都是“POST → 拿回新 status → 覆盖 state”，
     * 不做本地乐观更新，因为账号/模型/用量的真实结果只有 Host 知道。
     * 登录流程是唯一的例外：设备码登录是 Host 侧的一个会话，状态在 `login` 里，
     * 成功那一步才把新 status 取回来。
     */
    function KiroProxySettings({ ctx }) {
      const t = useMemo(() => translator(ctx), [ctx])
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [copied, setCopied] = useState('')
      const [draft, setDraft] = useState({ proxyUrl: '', region: '', profileArn: '', maxContextWindow: '' })
      // 登录流程：connectOpen=false 时整块不渲染；method 为空表示停在「选择登录方式」。
      const [connectOpen, setConnectOpen] = useState(false)
      const [method, setMethod] = useState('')
      const [fields, setFields] = useState(EMPTY_CONNECT_FIELDS)
      // 进行中的设备码登录：LoginView（{ id, method, state, userCode, verificationUri* }）。
      const [login, setLogin] = useState(undefined)
      // 登录/导入这一步自己的错误：它属于流程内部，不该顶掉页头的错误行。
      const [loginError, setLoginError] = useState('')

      // 组件卸载后 setState 是 React 的告警来源，也是真实的泄漏路径。
      // 这里用 `alive` 标志而不是 ctx.effect：ctx.effect 的生命周期是“插件加载到卸载”，
      // 而这里要跟的是“组件挂载到卸载”，只有 useEffect 的 cleanup 才对得上。
      // 每个异步回调落定时先问一句“我还活着吗”。
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const load = useCallback(async () => {
        try {
          const body = await request('/status')
          if (alive.current) {
            setStatus(body.value)
            setError('')
          }
          return body.value
        } catch (cause) {
          // 一行错误文字，不抛异常：设置页在白屏和崩溃之间必须选前者。
          if (alive.current) setError(messageOf(cause))
          return undefined
        }
      }, [])

      useEffect(() => {
        let active = true
        void load()
        // 30 秒轮询：设置页通常开着很久，模型/用量又会被别的入口改（例如另一个窗口切账号），
        // 所以需要回读；但 status 背后是一次模型目录 + 一次用量读取，不能太密。
        const poll = () => {
          if (active) void load()
        }
        const timer = window.setInterval(poll, 30000)
        return () => {
          active = false
          window.clearInterval(timer)
        }
      }, [load])

      const config = status && status.config ? status.config : undefined
      // 只在配置真的变了的时候重置草稿，否则用户正在输入的内容会被轮询冲掉。
      const configKey = config === undefined
        ? ''
        : JSON.stringify([config.proxyUrl ?? '', config.region ?? '', config.profileArn ?? '', config.maxContextWindow ?? ''])
      useEffect(() => {
        if (config === undefined) return
        setDraft({
          proxyUrl: config.proxyUrl ?? '',
          region: config.region ?? '',
          profileArn: config.profileArn ?? '',
          maxContextWindow: config.maxContextWindow === undefined || config.maxContextWindow === null
            ? ''
            : String(config.maxContextWindow),
        })
      }, [configKey])

      // 确认类提示是“新闻”而不是状态，自己消失，不留在用户已经离开的页面上。
      useEffect(() => {
        if (notice === '') return undefined
        const timer = window.setTimeout(() => setNotice(''), 6000)
        return () => window.clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (copied === '') return undefined
        const timer = window.setTimeout(() => setCopied(''), 2000)
        return () => window.clearTimeout(timer)
      }, [copied])

      // 轮询节奏跟着服务端给的 interval 走（slow_down 会把它调大）；Host 侧也会拦住过早的轮询。
      // 只在 pending 时挂计时器：成功/失败/取消后不再问 AWS。
      // 单个 setTimeout（不是 setInterval）保证不会重叠：上一轮落定后 state 变化重挂下一次。
      const loginId = login && login.state === 'pending' ? String(login.id || '') : ''
      const loginInterval = login && Number.isFinite(login.interval) ? Math.max(1, login.interval) : 5
      useEffect(() => {
        if (loginId === '') return undefined
        let cancelled = false
        const timer = window.setTimeout(() => {
          void request('/login/poll', { method: 'POST', body: JSON.stringify({ id: loginId }) })
            .then((body) => {
              if (!alive.current || cancelled) return
              const view = body.value || {}
              setLogin(view)
              if (view.state === 'success') {
                setConnectOpen(false)
                setMethod('')
                setLogin(undefined)
                setLoginError('')
                setFields(EMPTY_CONNECT_FIELDS)
                setNotice(t('connectDone'))
                if (body.status) setStatus(body.status)
                else void load()
              }
            })
            .catch((cause) => {
              if (!alive.current || cancelled) return
              // 轮询失败＝这次登录结束了：不重试，直接把可读的错误留在面板上。
              setLogin(undefined)
              setLoginError(messageOf(cause))
            })
        }, loginInterval * 1000)
        return () => {
          cancelled = true
          window.clearTimeout(timer)
        }
      }, [loginId, loginInterval, login, load, t])

      /** 统一的操作外壳：置忙、清错、成功后覆盖 status、失败只写一行错误。 */
      const run = useCallback(async (label, action) => {
        if (alive.current) { setBusy(label); setError('') }
        try {
          const next = await action()
          if (alive.current && next) setStatus(next)
          return next
        } catch (cause) {
          if (alive.current) setError(messageOf(cause))
          return undefined
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      const refresh = useCallback(() => run('refresh', async () => {
        const body = await request('/refresh', { method: 'POST' })
        // /refresh 的 value 就是刷新后的 status；万一是别的形状就回读一次，
        // 免得“点了刷新但界面没变”。
        return valueOrStatus(body)
      }), [run])

      const useAccount = useCallback((id) => run(`use:${id}`, async () => {
        const body = await request('/accounts/use', { method: 'POST', body: JSON.stringify({ id }) })
        return valueOrStatus(body)
      }), [run])

      const removeAccount = useCallback((id) => {
        // 删除不可撤销，所以先问一句；取消就什么都不做。
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('removeConfirm'))) {
          return Promise.resolve(undefined)
        }
        return run(`remove:${id}`, async () => {
          const body = await request('/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) })
          return valueOrStatus(body)
        })
      }, [run, t])

      const signOutAll = useCallback(() => run('signout', async () => {
        const body = await request('/accounts/signout', { method: 'POST', body: JSON.stringify({}) })
        return valueOrStatus(body)
      }), [run])

      /** 勾选即保存：模型集合是唯一会频繁变动的设置，不值得再多一个“保存”按钮。 */
      const toggleModel = useCallback((id, checked) => run(`model:${id}`, async () => {
        const current = status && Array.isArray(status.enabledModels) ? status.enabledModels : []
        const next = checked
          ? [...new Set([...current, id])]
          : current.filter(modelId => modelId !== id)
        const body = await request('/settings', { method: 'POST', body: JSON.stringify({ enabledModels: next }) })
        return valueOrStatus(body)
      }), [run, status])

      const setEnabledModels = useCallback((ids) => run('models:all', async () => {
        const body = await request('/settings', { method: 'POST', body: JSON.stringify({ enabledModels: ids }) })
        return valueOrStatus(body)
      }), [run])

      const saveConfig = useCallback(() => {
        const raw = String(draft.maxContextWindow || '').trim()
        if (raw !== '' && !/^[1-9][0-9]*$/u.test(raw)) {
          setError(t('maxContextInvalid'))
          return Promise.resolve(undefined)
        }
        // 空字符串在 Host 侧等于“删掉这个键”（SettingsStore.merge 的语义）。
        const patch = {
          proxyUrl: draft.proxyUrl.trim(),
          region: draft.region.trim(),
          profileArn: draft.profileArn.trim(),
          maxContextWindow: raw === '' ? '' : Number(raw),
        }
        return run('config', async () => {
          const body = await request('/settings', { method: 'POST', body: JSON.stringify(patch) })
          const next = await valueOrStatus(body)
          if (alive.current) setNotice(t('saved'))
          return next
        })
      }, [draft, run, t])

      const rotateKey = useCallback(() => run('key', async () => {
        const body = await request('/proxy-key', { method: 'POST', body: JSON.stringify({}) })
        // /proxy-key 只回 { key }，所以整份 status 要重读：代理卡里的三个字段都要更新。
        const next = body && body.status
        if (next) return next
        const after = await request('/status')
        return after.value
      }), [run])

      const copy = useCallback(async (id, value) => {
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error(t('copyFailed'))
          }
          await navigator.clipboard.writeText(String(value))
          if (alive.current) { setCopied(id); setNotice(t('copied')) }
        } catch (cause) {
          if (alive.current) setError(messageOf(cause))
        }
      }, [t])

      // ── 登录流程（chooser → form → pending → error）──

      /**
       * 放弃一个还在等授权的设备码会话。
       *
       * 设备码流程在 Host 侧是一个真实会话：面板关掉/重开却不取消它，它就一直在
       * 等到过期（还会占着 AWS 的轮询配额）。取消是尽力而为，不等结果也不报错。
       */
      const cancelPending = (view) => {
        if (view && view.state === 'pending' && view.id) {
          void request('/login/cancel', { method: 'POST', body: JSON.stringify({ id: view.id }) }).catch(() => {})
        }
      }

      const openConnect = useCallback(() => {
        cancelPending(login)
        setConnectOpen(true)
        setMethod('')
        setFields(EMPTY_CONNECT_FIELDS)
        setLogin(undefined)
        setLoginError('')
        setError('')
      }, [login])

      /**
       * 关掉登录面板。
       * “关闭”和“取消”是同一个动作：pending 时一并取消 Host 侧会话。
       */
      const closeConnect = useCallback(() => {
        cancelPending(login)
        setConnectOpen(false)
        setMethod('')
        setLogin(undefined)
        setLoginError('')
        setFields(EMPTY_CONNECT_FIELDS)
      }, [login])

      const chooseMethod = useCallback((id) => {
        setMethod(id)
        setFields(EMPTY_CONNECT_FIELDS)
        setLogin(undefined)
        setLoginError('')
        setError('')
      }, [])

      const backToChooser = useCallback(() => {
        setMethod('')
        setFields(EMPTY_CONNECT_FIELDS)
        setLogin(undefined)
        setLoginError('')
        setError('')
      }, [])

      /**
       * 发起一次登录/导入。
       *
       * 七个方法共用一条通道：`/login/start` 的 body 由 method 决定，
       * 导入类三个方法 Host 可能直接回 `state:'success'`，此时跳过 pending 直接收尾。
       */
      const startLogin = useCallback(async () => {
        const active = method
        if (active === '' || busy !== '') return undefined
        const payload = { method: active }
        if (active === 'idc') {
          const startUrl = String(fields.startUrl || '').trim()
          const region = String(fields.region || '').trim()
          if (startUrl === '' || region === '') { setError(t('idcMissing')); return undefined }
          payload.startUrl = startUrl
          payload.region = region
        } else if (active === 'refresh-token') {
          const token = String(fields.token || '').trim()
          if (token === '') { setError(t('tokenRequired')); return undefined }
          payload.secret = token
        } else if (active === 'api-key') {
          const key = String(fields.key || '').trim()
          if (key === '') { setError(t('keyRequired')); return undefined }
          payload.secret = key
        } else if (active === 'external-idp') {
          const json = String(fields.json || '').trim()
          if (json === '') { setError(t('jsonRequired')); return undefined }
          payload.json = json
        }
        const label = String(fields.label || '').trim()
        if (label !== '') payload.label = label

        if (alive.current) { setBusy('login'); setError(''); setLoginError('') }
        try {
          const body = await request('/login/start', { method: 'POST', body: JSON.stringify(payload) })
          const view = body.value || {}
          if (!alive.current) return view
          if (view.state === 'success') {
            // 导入类方法：凭据已经存好，不需要用户再看一个假的“等待授权”。
            setConnectOpen(false)
            setMethod('')
            setLogin(undefined)
            setLoginError('')
            setFields(EMPTY_CONNECT_FIELDS)
            setNotice(t('connectDone'))
            if (body.status) setStatus(body.status)
            else {
              const after = await request('/status')
              if (alive.current) setStatus(after.value)
            }
            return view
          }
          setLogin(view)
          return view
        } catch (cause) {
          if (alive.current) { setLogin(undefined); setLoginError(messageOf(cause)) }
          return undefined
        } finally {
          if (alive.current) setBusy('')
        }
      }, [busy, fields, method, t])

      // ── 渲染辅助 ──
      const card = (key, title, actions, body) => h('section', { className: 'dshkp-card', key },
        h('div', { className: 'dshkp-card-head' },
          h('div', { className: 'dshkp-card-title' }, title),
          actions === null || actions === undefined ? null : h('div', { className: 'dshkp-actions' }, actions)),
        body)

      // 连接配置全是单行输入；登录表单的输入有自己独立的状态（fields），
      // 因为它不该被 status 轮询重置，所以不共用这个 draft。
      const field = (name, label, options) => {
        const opts = options || {}
        return h('label', { className: `dshkp-field${opts.wide ? ' dshkp-field-wide' : ''}`, key: name },
          h('span', null, label),
          h('input', {
            className: 'dshkp-input',
            type: 'text',
            value: draft[name] === undefined ? '' : draft[name],
            placeholder: opts.placeholder,
            spellCheck: false,
            onChange: (event) => setDraft(current => ({ ...current, [name]: event.target.value })),
          }))
      }

      const connectField = (name, label, options) => {
        const opts = options || {}
        const value = fields[name] === undefined ? '' : fields[name]
        const onChange = (event) => setFields(current => ({ ...current, [name]: event.target.value }))
        const control = opts.textarea
          ? h('textarea', {
              className: 'dshkp-input dshkp-textarea', value, placeholder: opts.placeholder,
              spellCheck: false, onChange,
            })
          : h('input', {
              className: 'dshkp-input', type: opts.type || 'text', value, placeholder: opts.placeholder,
              spellCheck: false, autoComplete: 'off', onChange,
            })
        return h('label', { className: `dshkp-field${opts.wide ? ' dshkp-field-wide' : ''}`, key: name },
          h('span', null, label),
          control)
      }

      const stateLabel = (value) => value === 'ready'
        ? t('stateReady')
        : value === 'refresh' ? t('stateRefresh') : t('stateSignin')

      const sourceLabel = (value) => value === 'managed'
        ? t('sourceManaged')
        : value === 'kiro-cache' ? t('sourceKiroCache') : t('sourceNone')

      const busyLabel = (key, idle) => (busy === key ? t('working') : idle)

      // ── 登录方式清单 ──
      // 顺序即引导顺序：个人用户第一行就能点，企业/IAM 靠后，导入类垫底。
      const methodChoices = [
        { id: 'builder-id', icon: 'AWS', title: t('methodBuilderId'), description: t('methodBuilderIdDesc'), recommended: true },
        { id: 'idc', icon: 'SSO', title: t('methodIdc'), description: t('methodIdcDesc') },
        { id: 'google', icon: 'G', title: t('methodGoogle'), description: t('methodGoogleDesc') },
        { id: 'github', icon: 'GH', title: t('methodGithub'), description: t('methodGithubDesc') },
        { id: 'refresh-token', icon: '↻', title: t('methodRefreshToken'), description: t('methodRefreshTokenDesc') },
        { id: 'api-key', icon: 'KEY', title: t('methodApiKey'), description: t('methodApiKeyDesc') },
        { id: 'external-idp', icon: '{}', title: t('methodExternalIdp'), description: t('methodExternalIdpDesc') },
      ]
      const methodTitle = (id) => {
        const found = methodChoices.find(choice => choice.id === id)
        return found ? found.title : (id || t('connectTitle'))
      }
      const importMethod = method === 'refresh-token' || method === 'api-key' || method === 'external-idp'
      const loginState = login ? String(login.state || '') : ''
      // 流程步：pending 优先（它带着设备码），其次任何失败，最后才是 chooser / form。
      const connectStep = connectOpen === false
        ? 'closed'
        : login !== undefined && loginState === 'pending' ? 'pending'
        : login !== undefined && loginState !== 'success' ? 'error'
        : loginError !== '' ? 'error'
        : method === '' ? 'chooser' : 'form'

      // ── 账号卡 ──
      const accounts = status && Array.isArray(status.accounts) ? status.accounts : []
      const activeAccount = accounts.find(account => account && account.active === true)
      const statusLine = h('div', { className: 'dshkp-status-line' },
        h('span', { className: `dshkp-dot${activeAccount ? ' dshkp-dot-on' : ''}` }),
        h('span', null, activeAccount
          ? `${t('signedInAs')} ${activeAccount.label || activeAccount.id || t('unknown')}`
          : `${t('credentialSource')}: ${sourceLabel(status && status.credentialSource)}`))

      const accountsBody = accounts.length === 0
        ? h('div', { className: 'dshkp-empty' }, t('noAccounts'))
        : h('div', { className: 'dshkp-list' }, accounts.map(account => h('div', {
            key: account.id,
            className: `dshkp-row${account.active ? ' dshkp-row-active' : ''}`,
          },
          h('div', { className: 'dshkp-row-main' },
            h('div', { className: 'dshkp-row-title' },
              account.label || account.id || t('unknown'),
              account.active ? h('span', { className: 'dshkp-badge dshkp-badge-active' }, t('active')) : null),
            h('div', { className: 'dshkp-row-sub' },
              h('span', { className: 'dshkp-tag' }, account.method || t('unknown')),
              h('span', { className: 'dshkp-tag' }, account.region || '—'),
              h('span', { className: `dshkp-state dshkp-state-${account.state || 'signin'}` }, stateLabel(account.state)))),
          h('div', { className: 'dshkp-actions' },
            h('button', {
              className: 'dshkp-btn', type: 'button',
              disabled: busy !== '' || account.active === true,
              onClick: () => { void useAccount(account.id) },
            }, busyLabel(`use:${account.id}`, t('use'))),
            h('button', {
              className: 'dshkp-btn dshkp-danger', type: 'button',
              disabled: busy !== '',
              onClick: () => { void removeAccount(account.id) },
            }, busyLabel(`remove:${account.id}`, t('remove')))))))

      const accountsCard = card('accounts', t('accounts'),
        h(React.Fragment, null,
          h('button', {
            className: 'dshkp-btn dshkp-primary', type: 'button',
            disabled: busy !== '',
            onClick: openConnect,
          }, t('connect')),
          h('button', {
            className: 'dshkp-btn', type: 'button', disabled: busy !== '',
            onClick: () => { void refresh() },
          }, busyLabel('refresh', t('refreshUsage'))),
          h('button', {
            className: 'dshkp-btn', type: 'button', disabled: busy !== '' || accounts.length === 0,
            onClick: () => { void signOutAll() },
          }, busyLabel('signout', t('signOutAll')))),
        h(React.Fragment, null,
          statusLine,
          accountsBody))

      // ── 登录流程卡（面板内滚动，不遮挡账号列表）──
      const chooserBody = h(React.Fragment, null,
        h('p', { className: 'dshkp-chooser-copy' }, t('chooseMethod')),
        h('div', { className: 'dshkp-methods' }, methodChoices.map(choice => h('button', {
          className: 'dshkp-method',
          type: 'button',
          key: choice.id,
          'data-method': choice.id,
          disabled: busy !== '',
          onClick: () => chooseMethod(choice.id),
        },
        h('span', { className: 'dshkp-method-icon', 'aria-hidden': 'true' }, choice.icon),
        h('span', { className: 'dshkp-method-main' },
          h('span', { className: 'dshkp-method-title' }, choice.title,
            choice.recommended ? h('span', { className: 'dshkp-badge dshkp-badge-active' }, t('recommended')) : null),
          h('span', { className: 'dshkp-method-desc' }, choice.description)),
        h('span', { className: 'dshkp-chevron', 'aria-hidden': 'true' }, '›')))))

      // 每个方法的输入集合：只有 IdC 必填两项，导入类三项各缺一不可，其余不需要输入。
      let methodFields = null
      if (method === 'idc') {
        methodFields = h('div', { className: 'dshkp-grid' },
          connectField('startUrl', t('startUrl'), {
            wide: true, type: 'url', placeholder: 'https://my-org.awsapps.com/start',
          }),
          connectField('region', t('regionPlain'), { placeholder: 'us-east-1' }))
      } else if (method === 'refresh-token') {
        methodFields = h(React.Fragment, null,
          connectField('token', t('token'), { wide: true, textarea: true }),
          connectField('label', t('label')))
      } else if (method === 'api-key') {
        methodFields = h(React.Fragment, null,
          connectField('key', t('apiKey'), { wide: true, type: 'password' }),
          connectField('label', t('label')))
      } else if (method === 'external-idp') {
        methodFields = h(React.Fragment, null,
          connectField('json', t('jsonInput'), { wide: true, textarea: true }),
          connectField('label', t('label')))
      }

      const formBody = h(React.Fragment, null,
        h('div', { className: 'dshkp-step-head' },
          h('button', {
            className: 'dshkp-btn dshkp-back', type: 'button', disabled: busy !== '',
            onClick: backToChooser,
          }, `‹ ${t('back')}`),
          h('div', { className: 'dshkp-step-title' }, methodTitle(method))),
        methodFields === null ? null : h('div', { className: 'dshkp-form' }, methodFields),
        h('div', { className: 'dshkp-actions', style: { marginTop: '12px' } },
          h('button', {
            className: 'dshkp-btn dshkp-primary', type: 'button', disabled: busy !== '',
            onClick: () => { void startLogin() },
          }, busy === 'login' ? t('working') : importMethod ? t('saveImport') : t('startLogin'))))

      const pendingUri = login ? (login.verificationUriComplete || login.verificationUri) : undefined
      const pendingBody = h(React.Fragment, null,
        h('div', { className: 'dshkp-step-head' },
          h('button', {
            className: 'dshkp-btn dshkp-back', type: 'button', disabled: busy !== '',
            onClick: closeConnect,
          }, `‹ ${t('cancel')}`),
          h('div', { className: 'dshkp-step-title' }, methodTitle(login && login.method))),
        h('div', { className: 'dshkp-code', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'dshkp-code-row' },
            h('span', { className: 'dshkp-code-label' }, t('code')),
            h('code', { className: 'dshkp-code-value' }, (login && login.userCode) || '—'),
            h('button', {
              className: 'dshkp-btn', type: 'button', disabled: !(login && login.userCode),
              onClick: () => { void copy('login-code', login && login.userCode) },
            }, copied === 'login-code' ? t('copied') : t('copy'))),
          pendingUri === undefined || pendingUri === '' ? null : h('div', { className: 'dshkp-actions', style: { marginTop: '10px' } },
            h('a', {
              className: 'dshkp-btn dshkp-primary', href: pendingUri,
              target: '_blank', rel: 'noopener noreferrer',
            }, t('openLoginPage')))),
        h('div', { className: 'dshkp-working' }, t('waiting')))

      const errorBody = h(React.Fragment, null,
        h('div', { className: 'dshkp-error', role: 'alert' },
          (login && login.error) || loginError || t('failed')),
        h('div', { className: 'dshkp-actions', style: { marginTop: '10px' } },
          h('button', {
            className: 'dshkp-btn dshkp-primary', type: 'button', disabled: busy !== '',
            onClick: backToChooser,
          }, t('restart'))))

      // 卡片头只说明“现在在哪一步”，具体方法名在步骤头里（form 步会重复，所以这里不复述）。
      const connectTitle = connectStep === 'pending'
        ? t('pendingTitle')
        : connectStep === 'error' ? t('errorTitle') : t('connectTitle')
      const connectBody = connectStep === 'pending'
        ? pendingBody
        : connectStep === 'error' ? errorBody : connectStep === 'form' ? formBody : chooserBody

      const connectCard = connectOpen === false
        ? null
        : h('section', { className: 'dshkp-card dshkp-connect', key: 'connect' },
            h('div', { className: 'dshkp-card-head' },
              h('div', { className: 'dshkp-card-title' }, connectTitle),
              h('button', {
                className: 'dshkp-close', type: 'button', title: t('close'), 'aria-label': t('close'),
                onClick: closeConnect,
              }, '×')),
            connectBody)

      // ── 模型卡 ──
      const models = status && Array.isArray(status.models) ? status.models : []
      const enabledList = status && Array.isArray(status.enabledModels) ? status.enabledModels : []
      const enabledSet = new Set(enabledList)
      const modelsBody = models.length === 0
        ? h('div', { className: 'dshkp-empty' }, t('noModels'))
        : h('div', { className: 'dshkp-list' }, models.map((model) => {
            const checked = enabledSet.has(model.id)
            const meta = [
              model.id,
              Number.isFinite(model.contextWindow) ? `${t('contextWindow')} ${formatTokens(model.contextWindow)}` : '',
              Number.isFinite(model.maxTokens) ? `${t('maxTokens')} ${formatTokens(model.maxTokens)}` : '',
            ].filter(Boolean).join(' · ')
            return h('label', {
              key: model.id,
              className: `dshkp-model${checked ? '' : ' dshkp-model-off'}`,
            },
            h('input', {
              className: 'dshkp-check', type: 'checkbox', checked, disabled: busy !== '',
              onChange: (event) => { void toggleModel(model.id, event.target.checked) },
            }),
            h('span', { className: 'dshkp-model-text' },
              h('span', { className: 'dshkp-model-name' }, model.name || model.id),
              h('span', { className: 'dshkp-model-sub', title: meta }, meta)))
          }))

      const modelsCard = card('models', t('models'),
        h(React.Fragment, null,
          h('span', { className: 'dshkp-count' }, `${enabledList.length}/${models.length} ${t('selected')}`),
          h('button', {
            className: 'dshkp-link-btn', type: 'button', disabled: busy !== '' || models.length === 0,
            onClick: () => { void setEnabledModels(models.map(model => model.id)) },
          }, t('selectAll')),
          h('button', {
            className: 'dshkp-link-btn', type: 'button', disabled: busy !== '' || models.length === 0,
            onClick: () => { void setEnabledModels([]) },
          }, t('selectNone'))),
        h(React.Fragment, null,
          h('p', { className: 'dshkp-hint', style: { marginTop: 0 } }, t('modelsHint')),
          modelsBody))

      // ── 用量卡 ──
      // 与输入区徽标共用同一份读数：徽标回答「还能不能继续」，这张卡回答「都花在哪了」。
      const usage = status ? status.usage : null
      const usageRows = usage && Array.isArray(usage.rows) ? usage.rows : []
      const usageBody = !usage || usageRows.length === 0
        ? h('div', { className: 'dshkp-empty' }, t('noUsage'))
        : h(React.Fragment, null,
            h('div', { className: 'dshkp-usage-plan' },
              h('strong', null, usage.plan || 'Kiro'),
              Number.isFinite(usage.fetchedAt)
                ? h('span', { className: 'dshkp-count' }, `${t('updated')} ${formatDate(usage.fetchedAt)}`)
                : null),
            usageRows.map((row, index) => {
              const left = remainingPercent(row)
              const unlimited = !Number.isFinite(row.limit) || row.limit <= 0
              const tone = !Number.isFinite(left) ? '' : left < 5 ? ' dshkp-usage-critical' : left < 20 ? ' dshkp-usage-low' : ''
              const spent = Number.isFinite(left) ? Math.max(0, Math.min(100, 100 - left)) : 0
              return h('div', { className: 'dshkp-usage-row', key: `${row.label || 'row'}:${index}` },
                h('div', { className: 'dshkp-usage-label' }, row.label || t('unknown')),
                h('div', { className: 'dshkp-usage-amount' },
                  `${formatAmount(row.used)} / ${unlimited ? '∞' : formatAmount(row.limit)}`),
                unlimited
                  ? null
                  : h('div', { className: `dshkp-usage-bar${tone}` },
                      h('span', { className: 'dshkp-usage-bar-fill', style: { width: `${spent}%` } })),
                Number.isFinite(left)
                  ? h('div', { className: `dshkp-usage-left${tone}` }, t('quotaLeft').replace('{percent}', formatPercent(left, 0)))
                  : null,
                Number.isFinite(row.resetAt)
                  ? h('div', { className: 'dshkp-usage-reset' }, `${t('resets')} ${formatDate(row.resetAt)}`)
                  : null)
            }))

      const usageCard = card('usage', t('usage'),
        h('button', {
          className: 'dshkp-btn', type: 'button', disabled: busy !== '',
          onClick: () => { void refresh() },
        }, busyLabel('refresh', t('refreshUsage'))),
        usageBody)

      // ── 代理卡 ──
      const proxy = status && status.proxy ? status.proxy : undefined
      const kvRow = (id, label, value) => h('div', { className: 'dshkp-kv-row', key: id },
        h('span', { className: 'dshkp-kv-key' }, label),
        h('span', { className: 'dshkp-kv-value', title: value }, value || '—'),
        h('button', {
          className: 'dshkp-btn', type: 'button', disabled: !value,
          onClick: () => { void copy(id, value) },
        }, copied === id ? t('copied') : t('copy')))

      const proxyBody = proxy === undefined
        ? h('div', { className: 'dshkp-empty' }, t('proxyUnavailable'))
        : h('div', { className: 'dshkp-kv' },
            kvRow('openai', t('openaiBase'), proxy.openaiBaseUrl),
            kvRow('anthropic', t('anthropicBase'), proxy.anthropicBaseUrl),
            kvRow('key', t('apiKey'), proxy.key))

      const proxyCard = card('proxy', t('proxy'),
        h('button', {
          className: 'dshkp-btn', type: 'button', disabled: busy !== '',
          onClick: () => { void rotateKey() },
        }, busyLabel('key', t('rotateKey'))),
        proxyBody)

      // ── 连接配置卡 ──
      const connectionCard = card('connection', t('connection'),
        h('button', {
          className: 'dshkp-btn dshkp-primary', type: 'button', disabled: busy !== '',
          onClick: () => { void saveConfig() },
        }, busyLabel('config', t('save'))),
        h('div', { className: 'dshkp-form' },
          h('div', { className: 'dshkp-grid' },
            field('proxyUrl', t('proxyUrl'), { placeholder: 'http://127.0.0.1:7890' }),
            field('region', t('region'), { placeholder: 'us-east-1' }),
            field('profileArn', t('profileArn'), { wide: true, placeholder: 'arn:aws:codewhisperer:us-east-1:…:profile/…' }),
            field('maxContextWindow', t('maxContextWindow'), { placeholder: '200000' })),
          h('p', { className: 'dshkp-hint' }, t('maxContextHint'))))

      // ── 错误列表（Host 收集的模型/用量读取失败）──
      const errors = status && Array.isArray(status.errors) ? status.errors : []
      const errorsCard = errors.length === 0
        ? null
        : card('errors', t('errors'), null,
            h('ul', { className: 'dshkp-errors' }, errors.map((line, index) => h('li', { key: `${index}` }, line))))

      return h('div', { className: 'dshkp-wrap' },
        h('div', { className: 'dshkp-head' },
          h('h2', { className: 'dshkp-title' }, t('title')),
          h('div', { className: 'dshkp-actions' },
            h('button', {
              className: 'dshkp-btn', type: 'button', disabled: busy !== '',
              onClick: () => { void refresh() },
            }, busyLabel('refresh', t('refresh'))))),
        h('p', { className: 'dshkp-desc' }, t('description')),
        error === '' ? null : h('div', { className: 'dshkp-error', role: 'alert' }, `${t('failed')}: ${error}`),
        notice === '' ? null : h('div', { className: 'dshkp-notice' }, notice),
        status === undefined
          ? h('div', { className: 'dshkp-empty' }, t('loading'))
          : h(React.Fragment, null,
              accountsCard,
              connectCard,
              modelsCard,
              usageCard,
              proxyCard,
              connectionCard,
              errorsCard))
    }

    // ── 输入区徽标 ──────────────────────────────────────────────────────────

    /**
     * 输入框右侧的配额徽标。
     *
     * 存在的理由：决定“下一轮会不会被拒”的数字不该要求先打开设置页。
     * 只显示最紧的一行；没有可显示的东西时返回 null，绝不占位 ——
     * 输入区是宿主的空间，装饰品不该挤掉真正的控件。
     */
    function QuotaChip({ ctx, directory }) {
      const t = useMemo(() => translator(ctx), [ctx])
      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      // 是否显示由「本会话选中的模型」决定：只有路由到 kiro-proxy 时，这一轮才会
      // 花 Kiro 的额度。只看 current，不看 directory 的瞬时 status，否则目录重载
      // 时徽标会闪一下。宿主没给 directory（老版本）就永远不显示，而不是去猜。
      const subscribe = useCallback((onChange) => (
        directory && typeof directory.subscribe === 'function' ? directory.subscribe(onChange) : () => {}
      ), [directory])
      const getSnapshot = useCallback(() => (
        directory && typeof directory.getSnapshot === 'function' ? directory.getSnapshot() : undefined
      ), [directory])
      const selected = useStoreSnapshot(subscribe, getSnapshot, getSnapshot)
      const current = selected && selected.current ? selected.current : null
      const eligible = Boolean(current && current.provider === PROVIDER)

      const load = useCallback(async () => {
        try {
          const body = await request('/status')
          if (alive.current) setStatus(body.value)
        } catch {
          // 徽标只是装饰：失败就当作“没有数据”，不在输入区堆错误框。
          if (alive.current) setStatus(undefined)
        }
      }, [])

      useEffect(() => {
        // 没选 Kiro 时不读额度：既不浪费请求，也不显示与本会话无关的数字。
        if (!eligible) return undefined
        void load()
        // 五分钟一轮：Host 侧缓存本来就按分钟计，这里没必要更频繁。
        const timer = window.setInterval(() => { void load() }, 300000)
        return () => window.clearInterval(timer)
      }, [eligible, load])

      if (!eligible || !status) return null

      const tight = tightestRow(status.usage)
      if (tight === undefined) return null

      const percent = tight.left
      const tone = percent < 5 ? ' dshkp-quota-critical' : percent < 20 ? ' dshkp-quota-low' : ''
      const rows = status.usage && Array.isArray(status.usage.rows) ? status.usage.rows : []
      const detail = [
        status.usage && status.usage.plan ? status.usage.plan : 'Kiro',
        ...rows.map((row) => {
          const reset = Number.isFinite(row.resetAt) ? ` · ${t('resets')} ${formatDate(row.resetAt)}` : ''
          return `${row.label || t('unknown')}: ${formatAmount(row.used)} / ${formatAmount(row.limit)}${reset}`
        }),
      ].filter(Boolean).join('\n')

      const label = t('quotaLeft').replace('{percent}', formatPercent(percent, 0))

      return h('button', {
        className: `dshkp-quota${tone}`,
        type: 'button',
        title: detail,
        'aria-label': `${t('quotaTitle')}: ${label}`,
        disabled: busy,
        onClick: () => {
          // 点击是“现在就去问一次真数”，所以先 refresh 再读 status。
          setBusy(true)
          void request('/refresh', { method: 'POST' })
            .then(next => valueOrStatus(next))
            .then((next) => { if (alive.current && next) setStatus(next) })
            .catch(() => { /* 静默：徽标不报错，下一次轮询会自愈 */ })
            .finally(() => { if (alive.current) setBusy(false) })
        },
      },
      h('span', { className: 'dshkp-quota-dot' }),
      label)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 样式与插件同生共死：effect 的 disposer 在卸载/热重载时移除 <style>，
        // 否则重载几次页面里会堆几份同样的 CSS。
        if (typeof ctx.effect === 'function') ctx.effect(() => installStyle())
        else installStyle()

        // 文案注册必须在注册槽之前：槽的 label 会立刻被宿主调用。
        if (ctx.locale && typeof ctx.locale.register === 'function') ctx.locale.register(NS, { en, zh })

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'kiro-proxy',
          order: 13,
          // label 每次被调用时才解析文案：宿主重绘设置导航时能拿到当前语言，
          // 而不是 apply 那一刻的快照。
          label: () => translator(ctx)('title'),
        }, () => h(KiroProxySettings, { ctx })))

        // 徽标需要知道「这个会话选了哪个模型」，这个事实属于 modelDirectories 服务。
        // 用 slot 的 inject 选项按 sessionId 取该会话的目录 store；宿主没有这个服务
        // 时照样注册座位，但不带目录，徽标就保持不可见，而不是猜测路由。
        const registerQuota = (host) => {
          const resolver = host.modelDirectories
          const directoryFor = resolver && typeof resolver.directoryFor === 'function'
            ? resolver.directoryFor.bind(resolver)
            : undefined
          // 槽的 props 里没有插件 ctx，所以用一层包装把 ctx 注进去；其余 props 透传。
          const QuotaSlot = (props) => h(QuotaChip, { ...props, ctx })
          host.slots.inject('conversation.input.right', () => host.slots.register({
            name: 'conversation.input.right',
            id: 'kiro-proxy-quota',
            order: 21,
            locale: NS,
            ...directoryFor === undefined ? {} : {
              inject: (sessionId) => ({ directory: directoryFor(sessionId).store }),
            },
          }, QuotaSlot))
        }
        if (typeof ctx.inject === 'function') ctx.inject(['slots', 'modelDirectories'], registerQuota)
        else registerQuota(ctx)
      },
    }
  },
})
