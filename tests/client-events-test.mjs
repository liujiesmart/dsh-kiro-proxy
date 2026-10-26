// 客户端层回归：normalizeWireEvent 对 input 对象/缺 metadata 的处理
import { normalizeWireEvent } from "../lib/kiro-client.js"
let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log("PASS ", n) } else { fail++; console.log("FAIL ", n, d ?? "") } }

const start = normalizeWireEvent("toolUseEvent", { name: "get_time", toolUseId: "tu_1" })
check("首帧 name-only -> tool-start", start.kind === "tool-start" && start.name === "get_time", JSON.stringify(start))

const stop = normalizeWireEvent("toolUseEvent", { name: "get_time", stop: true, toolUseId: "tu_1" })
check("stop 帧 -> tool-stop", stop.kind === "tool-stop", JSON.stringify(stop))

const frag = normalizeWireEvent("toolUseEvent", { toolUseId: "tu_1", input: "{\"a\":" })
check("字符串片段 -> tool-delta", frag.kind === "tool-delta" && frag.argumentsDelta === "{\"a\":", JSON.stringify(frag))

const obj = normalizeWireEvent("toolUseEvent", { toolUseId: "tu_1", input: { a: 1 } })
check("对象 input -> JSON 字符串", obj.kind === "tool-delta" && JSON.parse(obj.argumentsDelta).a === 1, JSON.stringify(obj))

const nameAndInput = normalizeWireEvent("toolUseEvent", { toolUseId: "tu_1", name: "get_time", input: "{\"a\":1}" })
check("name+input 同帧 -> tool-delta（由 adapter 惰性建块）", nameAndInput.kind === "tool-delta", JSON.stringify(nameAndInput))

check("metadataEvent 解析 stopReason", normalizeWireEvent("metadataEvent", { stopReason: "TOOL_USE" }).stopReason === "TOOL_USE")

// 真实帧序列回归（实测 Kiro 在带参数的工具调用里会先发一帧 input:""）：
//   {name,id} / {input:"",name,id} / {input:"片段"} / {name,stop:true,id}
const open = normalizeWireEvent("toolUseEvent", { name: "read", toolUseId: "tu_9" })
check("首帧 -> tool-start", open.kind === "tool-start", JSON.stringify(open))
const emptyInput = normalizeWireEvent("toolUseEvent", { input: "", name: "read", toolUseId: "tu_9" })
// 归一化后仍是 tool-start，但 adapter 按 id 幂等，不会产出第二个块（见 adapter-test）。
check("空 input 帧仍是同一个调用的开始", emptyInput.kind === "tool-start" && emptyInput.id === "tu_9", JSON.stringify(emptyInput))
const fragment = normalizeWireEvent("toolUseEvent", { input: "{\"file_path\": \"a\"}", name: "read", toolUseId: "tu_9" })
check("参数帧带 name 也仍是 delta", fragment.kind === "tool-delta" && fragment.name === "read", JSON.stringify(fragment))
const stopFrame = normalizeWireEvent("toolUseEvent", { name: "read", stop: true, toolUseId: "tu_9" })
check("stop 帧 -> tool-stop", stopFrame.kind === "tool-stop", JSON.stringify(stopFrame))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
