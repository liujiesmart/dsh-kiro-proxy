/**
 * 「Input is too long.」的回归测试：巨型历史必须被压进预算，且结构仍然合法。
 *
 * Run: node .scratch/budget-test.mjs
 */

import { serializeRequest } from '../lib/kiro-serialize.js'

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

const BIG = 'x'.repeat(200_000) + '\nTAIL-MARKER'
const system = 'SYSTEM-PROMPT-MARKER ' + 'rules '.repeat(2000)

function build(messages, ctx = {}) {
  return serializeRequest({
    model: 'claude-opus-5.5',
    system,
    messages,
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }],
  }, { conversationId: 'c1', modelId: 'claude-opus-5.5', ...ctx })
}

// 40 轮工具循环，每轮一条 200k 的工具结果 —— 就是会把报文推到 8MB 的形状
function hugeHistory() {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '开始' }] }]
  for (let i = 0; i < 40; i += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id: `call_${i}`, name: 'read', arguments: '{}' }],
    })
    messages.push({
      role: 'tool',
      content: [{ type: 'text', text: `${i}:${BIG}` }],
      toolCallId: `call_${i}`,
    })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: '总结一下' }] })
  return messages
}

// ---------------------------------------------------------------------------
// 1. 巨型历史被压进默认预算
// ---------------------------------------------------------------------------
{
  const { body } = build(hugeHistory())
  const size = JSON.stringify(body).length
  check('报文被压进 320k 预算', size <= 320_000, `${size} chars`)
  check('仍然只有一个 currentMessage', typeof body.conversationState.currentMessage?.userInputMessage?.content === 'string')
  check('history 严格交替', (body.conversationState.history ?? []).every((entry, index) => (
    index % 2 === 0 ? 'userInputMessage' in entry : 'assistantResponseMessage' in entry
  )), JSON.stringify((body.conversationState.history ?? []).map(entry => Object.keys(entry)[0]).slice(0, 6)))
  check('history 以 assistant 结尾', (body.conversationState.history ?? []).at(-1)?.assistantResponseMessage !== undefined)
  check('system 仍然在报文里', JSON.stringify(body).includes('SYSTEM-PROMPT-MARKER'))
  check('最新一轮没被丢', body.conversationState.currentMessage.userInputMessage.content.includes('总结一下'))
}

// ---------------------------------------------------------------------------
// 2. 自定义预算生效
// ---------------------------------------------------------------------------
{
  const { body } = build(hugeHistory(), { maxRequestChars: 60_000 })
  const size = JSON.stringify(body).length
  check('自定义预算生效（60k）', size <= 60_000, `${size} chars`)
}

// ---------------------------------------------------------------------------
// 3. 单条超长工具结果被截断，且保留尾部
// ---------------------------------------------------------------------------
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_0', name: 'read', arguments: '{}' }] },
    { role: 'tool', content: [{ type: 'text', text: BIG }], toolCallId: 'call_0' },
    { role: 'user', content: [{ type: 'text', text: '结论呢' }] },
  ]
  const { body } = build(messages, { maxRequestChars: 50_000 })
  const blob = JSON.stringify(body)
  check('超长工具结果被截断', blob.includes('chars truncated'), blob.length)
  check('截断保留尾部标记', blob.includes('TAIL-MARKER'))
  check('报文在预算内', blob.length <= 50_000, blob.length)
}

// ---------------------------------------------------------------------------
// 4. 正常小请求不被改动
// ---------------------------------------------------------------------------
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你' }] },
    { role: 'user', content: [{ type: 'text', text: '再问一句' }] },
  ]
  const { body } = build(messages)
  check('小请求不截断', !JSON.stringify(body).includes('truncated'))
  check('小请求保留全部历史', (body.conversationState.history ?? []).length === 2, (body.conversationState.history ?? []).length)
}

// ---------------------------------------------------------------------------
// 5. 报文里不再有悬空的 toolResults（被丢掉的调用不能还被引用）
// ---------------------------------------------------------------------------
{
  const { body } = build(hugeHistory())
  const issued = new Set()
  for (const entry of body.conversationState.history ?? []) {
    for (const use of entry.assistantResponseMessage?.toolUses ?? []) issued.add(use.toolUseId)
  }
  const referenced = []
  for (const entry of [...(body.conversationState.history ?? []), body.conversationState.currentMessage]) {
    const message = entry.userInputMessage
    if (message === undefined) continue
    for (const result of message.userInputMessageContext?.toolResults ?? []) referenced.push(result.toolUseId)
  }
  check('没有悬空的 toolResults', referenced.every(id => issued.has(id)), referenced.slice(0, 5).join(','))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
