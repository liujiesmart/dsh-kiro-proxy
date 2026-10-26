/**
 * Kiro 的响应体是 `application/vnd.amazon.eventstream`：每帧 = 12 字节 prelude
 * （totalLength、headerLength、preludeCRC）+ header 区 + JSON payload + 4 字节
 * message CRC。TCP/TLS 的读边界与帧边界完全无关，一次 read 可能停在 prelude、
 * header 名字、header 值或 payload 的任意一个字节上，所以这里只做「累积 + 整帧
 * 才产出」，绝不假设一次 chunk 等于一帧。
 *
 * 两个 CRC 都不校验：传输层已经保证字节完整性，而 CRC 错误的帧在 payload 做
 * JSON 解析时同样会暴露；省掉每帧两轮 CRC 计算，把失败留给能给出更好报错的层。
 *
 * 这里刻意不用 Buffer：同一份解码器要同时服务 `fetch` 的 ReadableStream 与
 * Node 的 IncomingMessage，Uint8Array/DataView/TextDecoder 是两边都有的最大公约数。
 *
 * @module dsh-kiro-proxy/kiro-eventstream
 */

import { kiroError } from './kiro-error.js'

/** header 之前的固定字节数：totalLength(4) + headerLength(4) + preludeCRC(4)。 */
const PRELUDE_BYTES = 12
/** payload 之后的 message CRC 字节数。 */
const MESSAGE_CRC_BYTES = 4
/** header 值类型标记：7 = UTF-8 字符串，Kiro 只发这一种。 */
const HEADER_TYPE_STRING = 7
/**
 * 单帧缓冲上限。AWS 把 event-stream 单帧封顶在 16 MiB，所以声明长度超过它的
 * 帧不是「大消息」而是流已经失步；直接拒绝可以给内存一个硬边界，而不是无限等
 * 一个永远不会到齐的帧。
 */
const MAX_FRAME_BYTES = 0x1000000

/** 给一个 Uint8Array 建同窗口的 DataView（尊重 byteOffset）。 */
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

const utf8 = new TextDecoder()

/** 把 [from, from+count) 这段字节按 UTF-8 解成字符串。 */
function utf8Slice(bytes, from, count) {
  return utf8.decode(bytes.subarray(from, from + count))
}

function malformed(message) {
  return kiroError(message, 'MALFORMED_RESPONSE')
}

/**
 * 把任意「字节容器」规整成 Uint8Array。
 *
 * 调用方可能给 Buffer（Node 的 chunk）、Uint8Array、ArrayBuffer 或者带
 * byteOffset 的 TypedArray/DataView。Buffer 是 Uint8Array 的子类，直接透传即可；
 * 其他视图必须按 byteOffset/byteLength 切，否则会读到视图窗口之外的字节。
 * @param {unknown} chunk - 一个读取单元。
 * @returns {Uint8Array} 可直接拼接的字节视图。
 * @throws 当传入值根本不是字节容器时抛 `MALFORMED_RESPONSE`。
 */
function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  throw kiroError(
    `Kiro event stream produced a non-binary chunk of type ${typeof chunk}`,
    'MALFORMED_RESPONSE',
  )
}

/**
 * 解析一帧的 header 区。
 *
 * header 是自描述的紧凑编码：nameLen(u8) + name + type(u8) + valueLen(u16) +
 * value。名字和值都是 UTF-8，长度是字节数而不是字符数，所以必须用
 * subarray + TextDecoder 而不是字符串切片。每一步都先验界再读：header 区一旦
 * 越界，说明 headerLength 与实际内容不符，继续读只会拿到别的帧的字节。
 * @param {Uint8Array} buffer - 整个已缓冲的流。
 * @param {number} start - 第一个 header 字节的下标。
 * @param {number} end - header 区之后一个字节的下标。
 * @returns {Record<string,string>} header 名值对。
 * @throws `MALFORMED_RESPONSE` 当 header 区被截断或值类型不是字符串。
 */
function decodeHeaders(buffer, start, end) {
  const dv = viewOf(buffer)
  /** @type {Record<string,string>} */
  const out = {}
  let pos = start
  while (pos < end) {
    const nameByte = dv.getUint8(pos)
    pos += 1
    const needForValue = nameByte + 3 // type(1) + valueLen(2)
    if (pos + needForValue > end) {
      throw malformed(`Kiro event-stream header name of ${nameByte} bytes runs past the header block`)
    }
    const fieldName = utf8Slice(buffer, pos, nameByte)
    pos += nameByte
    const fieldType = dv.getUint8(pos)
    pos += 1
    if (fieldType !== HEADER_TYPE_STRING) {
      // 只有字符串 header 能出现在 Kiro 的事件里（:event-type、:message-type…）；
      // 别的类型意味着帧已经错位，继续解析会把二进制当文本塞进 headers。
      throw malformed(`Kiro event-stream header "${fieldName}" has unsupported value type ${fieldType}`)
    }
    const valLen = dv.getUint16(pos)
    pos += 2
    if (pos + valLen > end) {
      throw malformed(`Kiro event-stream header "${fieldName}" value of ${valLen} bytes runs past the header block`)
    }
    out[fieldName] = utf8Slice(buffer, pos, valLen)
    pos += valLen
  }
  return out
}

/**
 * 把字节流解成完整帧。
 *
 * 流在帧中间结束属于截断而不是可冲刷的尾巴：这条响应已经不可信，抛错比产出一个
 * 半帧更诚实——半帧的 payload 一定不是合法 JSON，上层只会拿到一个更难解释的解析错误。
 * @param {AsyncIterable<Uint8Array>} stream - 原始响应字节，任意切分方式。
 * @param {() => void} [onActivity] - 每次读到的回调；让空闲看门狗能区分「模型慢」
 *   和「socket 死了」。
 * @returns {AsyncGenerator<{headers: Record<string,string>, payload: Uint8Array}>}
 *   按到达顺序产出整帧，payload 是未解码的原始字节（对 Kiro 来说是 JSON）。
 * @throws `MALFORMED_RESPONSE` 帧声明长度不合理；`STREAM_CLOSED` 流在帧中间结束。
 */
export async function* decodeFrames(stream, onActivity) {
  /** @type {Uint8Array} */
  let buffered = new Uint8Array(0)
  for await (const chunk of stream) {
    if (typeof onActivity === 'function') onActivity()
    const bytes = asBytes(chunk)
    if (bytes.length === 0) continue
    // 逐次拼接而不是维护「已消费偏移」：Kiro 的帧数很少，拼接的拷贝成本远低于
    // 一个 offset 状态机带来的错位风险，而 subarray 只做视图不复制。
    const next = new Uint8Array(buffered.length + bytes.length)
    next.set(buffered)
    next.set(bytes, buffered.length)
    buffered = next

    for (;;) {
      if (buffered.length < PRELUDE_BYTES) break
      const dv = viewOf(buffered)
      const frameLen = dv.getUint32(0)
      const hdrLen = dv.getUint32(4)
      // 长度自洽性检查放在「等更多字节」之前：一个失步的流永远等不到声明的长度，
      // 不在这里拒绝就会静默吃掉整条连接。
      const minLen = PRELUDE_BYTES + hdrLen + MESSAGE_CRC_BYTES
      if (frameLen > MAX_FRAME_BYTES || frameLen < minLen) {
        throw malformed(`Kiro event-stream frame declares an implausible length of ${frameLen} bytes`)
      }
      if (buffered.length < frameLen) break
      const hdrStart = PRELUDE_BYTES
      const hdrEnd = hdrStart + hdrLen
      const payloadEnd = frameLen - MESSAGE_CRC_BYTES
      yield {
        headers: decodeHeaders(buffered, hdrStart, hdrEnd),
        // payload 视图指向 buffered 的底层 ArrayBuffer；buffered 之后只会被整体
        // 替换而不会被就地改写，所以这个视图在消费者手里一直有效。
        payload: buffered.subarray(hdrEnd, payloadEnd),
      }
      buffered = buffered.subarray(frameLen)
    }
  }
  if (buffered.length > 0) {
    const remaining = buffered.length
    throw kiroError(
      `Kiro event stream ended with ${remaining} bytes of an incomplete frame`,
      'STREAM_CLOSED',
    )
  }
}
