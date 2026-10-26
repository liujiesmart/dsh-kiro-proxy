/**
 * 一次性跑完所有离线套件。
 *
 * 存在的理由很具体：这个插件曾被另一个进程改坏过（构造器里裸用未导入的 `join`、
 * 调用 `text()` 但定义叫 `trimmed()`），而当时没人重跑测试，直到装进 Host 才以
 * "设置页 404" 的形式暴露。一个命令能跑完全部检查，改完就顺手跑一下。
 *
 * Run: node tests/run-all.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 离线套件：不需要 Host、不需要凭据。acceptance 需要运行中的 Host，单独跑。 */
const SUITES = [
  'wire-selftest.mjs',
  'translate-selftest.mjs',
  'adapter-test.mjs',
  'auth-test.mjs',
  'login-test.mjs',
  'client-events-test.mjs',
  'retry-test.mjs',
  'fallback-test.mjs',
  'budget-test.mjs',
  'continue-test.mjs',
  'proxy-e2e.mjs',
  'host-smoke.mjs',
  'ui-render-test.mjs',
  'import-integrity.mjs',
]

let failed = 0
for (const suite of SUITES) {
  const path = join(here, suite)
  const result = spawnSync(process.execPath, [path], { cwd: root, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const summary = output.split('\n').filter(line => /passed|RESULT|OK\b|FAIL/.test(line)).slice(-1)[0] ?? ''
  const ok = result.status === 0
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(24)} ${summary.trim().slice(0, 90)}`)
  if (!ok) console.log(output.split('\n').slice(-12).join('\n'))
}

if (failed > 0) {
  console.log(`\n${failed} suite(s) failed`)
  process.exit(1)
}
console.log('\nall offline suites passed')
