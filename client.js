/**
 * dsh-kiro-proxy — Harness Web UI 客户端模块。
 *
 * 两个座位（slot）：
 * - `settings.section`：完整的 Kiro Proxy 设置页（用量、账号配置、模型勾选、代理信息、连接配置、导入）。
 * - `conversation.input.right`：输入框右侧的配额徽标，只显示“最紧那一行”的剩余比例。
 *
 * 设计约束（为什么这么写）：
 * - 唯一数据来源是 Host 的 `GET /kiro-proxy/api/status`（见 docs/CONTRACT.md 第 5 节）。
 *   UI 不碰 Host Service、不读别人的 DOM，所以宿主换内部实现时这里不用改。
 * - 无构建、无 npm 依赖：只用 `require('react')` 拿宿主的 React 实例，
 *   避免页面里出现第二份 React。
 * - 所有副作用（样式表）都走 `ctx.effect` 并返回 disposer，插件卸载/热重载后不留孤儿节点。
 * - 所有 fetch 失败都渲染成一行错误文字：设置页不该因为一次网络抖动整块白屏。
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
      stateReady: 'Ready',
      stateRefresh: 'Refreshes on next use',
      stateSignin: 'Needs sign-in',

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
      addAccount: 'Add account',
      proxyUrl: 'Proxy URL (optional)',
      region: 'AWS region (optional)',
      profileArn: 'Profile ARN (optional)',
      maxContextWindow: 'Max context window (optional)',
      maxContextHint: 'Empty follows each model. A smaller number spends fewer tokens per turn.',
      maxContextInvalid: 'Enter a positive integer token count, or leave it empty.',

      importTitle: 'Import credentials',
      importHint: 'Paste one of: a credential JSON, a Kiro refresh token, or a Kiro API key.',
      credentialText: 'Credential',
      label: 'Label (optional)',
      importJson: 'Import JSON',
      importRefresh: 'Import refresh token',
      importApiKey: 'Import API key',

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
      stateReady: '可用',
      stateRefresh: '下次使用时刷新',
      stateSignin: '需要登录',

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
      addAccount: '添加账号',
      proxyUrl: '代理地址（可选）',
      region: 'AWS 区域（可选）',
      profileArn: 'Profile ARN（可选）',
      maxContextWindow: '最大上下文窗口（可选）',
      maxContextHint: '留空则跟随各模型；数值越小，每轮消耗的 token 越少。',
      maxContextInvalid: '请输入正整数 token 数，或留空。',

      importTitle: '导入凭据',
      importHint: '粘贴以下之一：凭据 JSON、Kiro refresh token、Kiro API key。',
      credentialText: '凭据内容',
      label: '标签（可选）',
      importJson: '导入 JSON',
      importRefresh: '导入 refresh token',
      importApiKey: '导入 API key',

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
.dshkp-notice{margin:0 0 12px;padding:8px 10px;border:1px solid var(--dsw-alias-state-success-secondary,rgba(34,197,94,.4));border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(34,197,94,.1));color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px}
.dshkp-empty{padding:6px 0;color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:12px}
.dshkp-details{margin:0 0 12px}
.dshkp-summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;color:var(--dsw-alias-label-primary,#f9fafb);font-size:12px;line-height:18px;user-select:none}
.dshkp-summary::-webkit-details-marker{display:none}
.dshkp-summary::before{content:'+';font-family:ui-monospace,Menlo,monospace;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-details[open] .dshkp-summary::before{content:'−'}
.dshkp-summary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.dshkp-details[open] .dshkp-card{margin-top:10px}
.dshkp-list{display:grid;gap:8px}
.dshkp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));border-radius:9px}
.dshkp-row-active{border-color:var(--dsw-alias-brand-primary,rgba(99,102,241,.7));background:var(--dsw-alias-fill-l1,rgba(99,102,241,.1))}
.dshkp-row-main{min-width:0;display:grid;gap:3px}
.dshkp-row-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f9fafb);word-break:break-all}
.dshkp-row-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8)}
.dshkp-tag{padding:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.dshkp-badge{padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600}
.dshkp-badge-active{background:var(--dsw-alias-state-success-secondary,rgba(34,197,94,.18));color:var(--dsw-alias-state-success-primary,#22c55e)}
.dshkp-state{display:inline-flex;align-items:center;gap:5px}
.dshkp-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9ca3af)}
.dshkp-state-ready::before{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dshkp-state-refresh::before{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dshkp-state-signin::before{background:var(--dsw-alias-state-error-primary,#ef4444)}
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
.dshkp-errors{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-state-error-primary,#ef4444);word-break:break-word}
.dshkp-quota{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);font-family:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dshkp-quota:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.dshkp-quota:disabled{cursor:progress;opacity:.7}
.dshkp-quota-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none}
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
     */
    function KiroProxySettings({ ctx }) {
      const t = useMemo(() => translator(ctx), [ctx])
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [copied, setCopied] = useState('')
      const [draft, setDraft] = useState({ proxyUrl: '', region: '', profileArn: '', maxContextWindow: '' })
      const [importText, setImportText] = useState('')
      const [importLabel, setImportLabel] = useState('')

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
          if (alive.current) setError(cause && cause.message ? cause.message : String(cause))
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

      /** 统一的操作外壳：置忙、清错、成功后覆盖 status、失败只写一行错误。 */
      const run = useCallback(async (label, action) => {
        if (alive.current) { setBusy(label); setError('') }
        try {
          const next = await action()
          if (alive.current && next) setStatus(next)
          return next
        } catch (cause) {
          if (alive.current) setError(cause && cause.message ? cause.message : String(cause))
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
        await request('/proxy-key', { method: 'POST', body: JSON.stringify({}) })
        const body = await request('/status')
        return body.value
      }), [run])

      /**
       * 导入凭据。
       * 三个按钮共用一个 textarea：用户手里可能是 JSON、refresh token 或 API key，
       * 由按钮决定这次粘贴按哪种语义解释，避免让用户先选“类型”再粘贴。
       */
      const importCredential = useCallback((kind) => {
        const value = importText.trim()
        if (value === '') return Promise.resolve(undefined)
        const payload = { label: importLabel.trim() || undefined }
        if (kind === 'json') payload.json = value
        else if (kind === 'refresh') payload.refreshToken = value
        else payload.apiKey = value
        return run(`import:${kind}`, async () => {
          const body = await request('/accounts/import', { method: 'POST', body: JSON.stringify(payload) })
          const next = await valueOrStatus(body)
          if (alive.current) { setImportText(''); setNotice(t('saved')) }
          return next
        })
      }, [importText, importLabel, run, t])

      const copy = useCallback(async (id, value) => {
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error(t('copyFailed'))
          }
          await navigator.clipboard.writeText(String(value))
          if (alive.current) { setCopied(id); setNotice(t('copied')) }
        } catch (cause) {
          if (alive.current) setError(cause && cause.message ? cause.message : String(cause))
        }
      }, [t])

      // ── 渲染辅助 ──
      const card = (key, title, actions, body) => h('section', { className: 'dshkp-card', key },
        h('div', { className: 'dshkp-card-head' },
          h('div', { className: 'dshkp-card-title' }, title),
          actions === null || actions === undefined ? null : h('div', { className: 'dshkp-actions' }, actions)),
        body)

      // 连接配置全是单行输入；多行的凭据输入有自己独立的状态（importText），
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

      const stateLabel = (value) => value === 'ready'
        ? t('stateReady')
        : value === 'refresh' ? t('stateRefresh') : t('stateSignin')

      const sourceLabel = (value) => value === 'managed'
        ? t('sourceManaged')
        : value === 'kiro-cache' ? t('sourceKiroCache') : t('sourceNone')

      const busyLabel = (key, idle) => (busy === key ? t('working') : idle)

      // ── 账号卡 ──
      const accounts = status && Array.isArray(status.accounts) ? status.accounts : []
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
            className: 'dshkp-btn', type: 'button', disabled: busy !== '' || accounts.length === 0,
            onClick: () => { void signOutAll() },
          }, busyLabel('signout', t('signOutAll'))),
          h('button', {
            className: 'dshkp-btn', type: 'button', disabled: busy !== '',
            onClick: () => { void refresh() },
          }, busyLabel('refresh', t('refresh')))),
        h(React.Fragment, null,
          h('div', { className: 'dshkp-row-sub', style: { marginBottom: '8px' } },
            h('span', null, `${t('credentialSource')}: ${sourceLabel(status && status.credentialSource)}`)),
          accountsBody))

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
            className: 'dshkp-btn', type: 'button', disabled: busy !== '' || models.length === 0,
            onClick: () => { void setEnabledModels(models.map(model => model.id)) },
          }, t('selectAll')),
          h('button', {
            className: 'dshkp-btn', type: 'button', disabled: busy !== '' || models.length === 0,
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
        }, busyLabel('usage', t('refreshUsage'))),
        usageBody)

      // ── 代理卡 ──
      const proxy = status && status.proxy ? status.proxy : undefined
      const kvRow = (id, key, label, value) => h('div', { className: 'dshkp-kv-row', key },
        h('span', { className: 'dshkp-kv-key' }, label),
        h('span', { className: 'dshkp-kv-value', title: value }, value || '—'),
        h('button', {
          className: 'dshkp-btn', type: 'button', disabled: !value,
          onClick: () => { void copy(id, value) },
        }, copied === id ? t('copied') : t('copy')))

      const proxyBody = proxy === undefined
        ? h('div', { className: 'dshkp-empty' }, t('proxyUnavailable'))
        : h('div', { className: 'dshkp-kv' },
            kvRow('openai', 'openai', t('openaiBase'), proxy.openaiBaseUrl),
            kvRow('anthropic', 'anthropic', t('anthropicBase'), proxy.anthropicBaseUrl),
            kvRow('key', 'key', t('apiKey'), proxy.key))

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

      // ── 导入卡 ──
      // 账号导入不是常驻表单：打开设置页时最该看到的是「现在用哪个账号 + 花了多少」，
      // 粘贴凭据是低频动作，所以折进 <details>。原生折叠不占 React 状态，
      // 组件重挂载也不会丢用户的展开/收起选择。
      const importCard = h('details', { className: 'dshkp-details', key: 'import' },
        h('summary', { className: 'dshkp-summary' }, t('addAccount')),
        card('import', t('importTitle'), null,
        h('div', { className: 'dshkp-form' },
          h('p', { className: 'dshkp-hint', style: { marginTop: 0 } }, t('importHint')),
          h('label', { className: 'dshkp-field' },
            h('span', null, t('label')),
            h('input', {
              className: 'dshkp-input', type: 'text', value: importLabel, spellCheck: false,
              onChange: (event) => setImportLabel(event.target.value),
            })),
          h('label', { className: 'dshkp-field' },
            h('span', null, t('credentialText')),
            h('textarea', {
              className: 'dshkp-input dshkp-textarea', value: importText, spellCheck: false,
              onChange: (event) => setImportText(event.target.value),
            })),
          h('div', { className: 'dshkp-actions' },
            h('button', {
              className: 'dshkp-btn dshkp-primary', type: 'button', disabled: busy !== '' || importText.trim() === '',
              onClick: () => { void importCredential('json') },
            }, busyLabel('import:json', t('importJson'))),
            h('button', {
              className: 'dshkp-btn', type: 'button', disabled: busy !== '' || importText.trim() === '',
              onClick: () => { void importCredential('refresh') },
            }, busyLabel('import:refresh', t('importRefresh'))),
            h('button', {
              className: 'dshkp-btn', type: 'button', disabled: busy !== '' || importText.trim() === '',
              onClick: () => { void importCredential('apiKey') },
            }, busyLabel('import:apiKey', t('importApiKey')))))))

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
              usageCard,
              accountsCard,
              importCard,
              modelsCard,
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
