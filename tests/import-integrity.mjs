/**
 * 导入完整性：模块能加载、导出的东西能真的被调用、没有"裸用未导入的库函数"。
 *
 * 这条检查针对的是一个真实事故：插件的 Host 半曾在构造器里裸用 `join`（文件只有
 * `import * as path`），于是 `apply()` 抛 ReferenceError → 整个插件 activation 失败
 * → 设置页拿到 404，而 `node --check` 与单元测试都看不出来（语法合法、路径没走到）。
 *
 * Run: node tests/import-integrity.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const check = (name, condition, detail) => {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
    return
  }
  fail += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
}

// ── 1. 每个模块都能 import，且导出非空 ──────────────────────────────────
const libFiles = readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js')).sort()
const modules = ['../index.js', ...libFiles.map(name => `../lib/${name}`)]
for (const specifier of modules) {
  try {
    const module = await import(new URL(specifier, `file://${join(here, 'x.js').replaceAll('\\', '/')}`))
    const exports = Object.keys(module)
    check(`import ${specifier.replace('../', '')}`, exports.length > 0, `${exports.length} exports`)
  } catch (error) {
    check(`import ${specifier.replace('../', '')}`, false, error.message)
  }
}

// ── 2. 没有裸用 node 内置函数（只允许命名空间或显式导入）────────────────
const NAMES = [
  // `resolve` 不在此列：Node 的 Promise 执行器与流回调里到处是匿名 resolve 参数，
  // 静态判断分不清"匿名参数"与"漏了导入"，误报比漏报更糟。
  'join', 'basename', 'dirname', 'homedir',
  'readFile', 'writeFile', 'mkdir', 'rename', 'unlink', 'readdir', 'stat',
  'randomUUID', 'createHash', 'hostname',
]
const sourceFiles = ['index.js', ...libFiles.map(name => `lib/${name}`)]
const problems = []
for (const relative of sourceFiles) {
  const text = readFileSync(join(root, relative), 'utf8')
  for (const name of NAMES) {
    const bare = new RegExp(`(^|[^.\\w'"\`])${name}\\(`, 'm')
    if (!bare.test(text)) continue
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(text)
    const declared = new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(text)
    if (!imported && !declared) problems.push(`${relative}: ${name}()`)
  }
}
check('没有裸用未导入的库函数', problems.length === 0, problems.join(', '))

// ── 3. 本地辅助函数都有定义（换了名字要一起改）──────────────────────────
const HELPERS = ['text', 'record', 'positiveInteger', 'kiroError', 'resultText']  // 不含 resolve：同上
for (const relative of sourceFiles) {
  const text = readFileSync(join(root, relative), 'utf8')
  for (const helper of HELPERS) {
    const used = new RegExp(`(^|[^.\\w'"\`])${helper}\\(`, 'm').test(text)
    if (!used) continue
    const defined = new RegExp(`(?:function|const|let|var)\\s+${helper}\\b`).test(text)
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${helper}\\b[^}]*\\}\\s*from`).test(text)
    const parameter = new RegExp(`[(,]\\s*${helper}\\s*[,)=]`).test(text)
    if (!defined && !imported && !parameter) problems.push(`${relative}: ${helper}() 未定义`)
  }
}
check('本地辅助函数都有定义或导入', problems.length === 0, problems.join(', '))

// ── 4. 真的构造一遍插件对象（事故就发生在这里）──────────────────────────
{
  const { AccountStore } = await import('../lib/kiro-auth.js')
  const directory = await mkdtemp(join(tmpdir(), 'kiro-integrity-'))
  const store = new AccountStore(directory)
  check('AccountStore 能构造（路径拼接无裸调用）', typeof store.read === 'function')
  const account = await store.save({ credential: { accessToken: 'ksk_probe', authMethod: 'api_key', region: 'us-east-1' }, label: 'probe' })
  check('AccountStore 能写盘', account.id.length > 0)
  const described = await store.describe()
  check('AccountStore 能读回', described.accounts.length === 1)
  const removed = await store.remove(account.id)
  check('AccountStore 能删除', removed === true)
}

// ── 5. apply() 在假 ctx 里能跑完（activation 的等价物）─────────────────
{
  const { apply } = await import('../index.js')
  const registered = { adapters: 0, providers: 0, routes: 0 }
  const ctx = {
    llm: {
      registerAdapter: () => { registered.adapters += 1; return () => {} },
      registerConfigurableProviders: () => { registered.providers += 1; return () => {} },
    },
    effect: factory => factory(),
    inject: (names, callback) => {
      if (!names.includes('webServer')) return
      callback({
        webServer: {
          getOrigin: () => 'http://127.0.0.1:1',
          register: () => { registered.routes += 1; return () => {} },
        },
        effect: factory => factory(),
      })
    },
  }
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'kiro-integrity-home-'))
  let error
  try {
    apply(ctx, {})
  } catch (cause) {
    error = cause
  }
  check('apply() 不抛异常', error === undefined, error?.message)
  check('注册了 adapter', registered.adapters === 1, registered.adapters)
  check('注册了可配置 provider', registered.providers === 1, registered.providers)
  check('挂了 web 路由', registered.routes === 2, registered.routes)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
