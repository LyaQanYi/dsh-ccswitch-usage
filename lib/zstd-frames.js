// Scan and decode DSH session logs.
//
// DSH's jsonl backend appends its log as a sequence of *independent* zstd frames:
// every flushed event batch is one complete frame written right after the previous
// one. The tail frame may be half-written while a session is still running, so a
// whole-file `zstdDecompress` would fail (or silently drop the good frames) — we
// have to walk frame boundaries structurally first and only decode complete frames.
//
// The scanner below is a 1:1 port of CC Switch's own DSH importer
// (`scan_zstd_frames` in `session_usage_dsh.rs`), so both readers agree on where
// one frame ends and the next begins.

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** zstd frame magic number, read little-endian. */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * @param {Uint8Array} value
 * @returns {import('node:buffer').Buffer}
 */
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('scanZstdFrames expects a Buffer or Uint8Array')
}

/**
 * Structural scan of one frame starting at `start`.
 * @returns {number} end offset (exclusive), or -1 when the frame is incomplete/invalid.
 */
function scanFrame(buf, start) {
  const total = buf.length
  let offset = start

  if (total - offset < 4) return -1
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return -1
  offset += 4

  // Frame header: one descriptor byte, then optional window/dict/content-size fields.
  if (offset >= total) return -1
  const descriptor = buf[offset]
  offset += 1
  // Bit 3 (unused) and bit 4 (reserved) must be zero.
  if ((descriptor & 0x18) !== 0) return -1

  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const windowDescriptorBytes = singleSegment ? 0 : 1

  const headerTail = windowDescriptorBytes + dictionaryBytes + contentSizeBytes
  if (total - offset < headerTail) return -1
  offset += headerTail

  // Blocks: 3-byte little-endian header, then the block payload.
  for (;;) {
    if (total - offset < 3) return -1
    const header = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16)
    offset += 3
    const lastBlock = (header & 1) !== 0
    const blockType = (header >>> 1) & 0x03
    const blockSize = header >>> 3
    if (blockType === 3) return -1 // reserved block type: structurally broken
    // RLE blocks carry exactly one byte regardless of the declared size.
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (total - offset < payloadBytes) return -1
    offset += payloadBytes
    if (lastBlock) break
  }

  if (checksum) {
    if (total - offset < 4) return -1
    offset += 4
  }

  return offset
}

/**
 * 扫描拼接的 zstd 帧，返回完整帧的 [start,end) 区间数组；末尾残缺帧不计入。
 * @param {Uint8Array} buf
 * @returns {Array<[number, number]>}
 */
export function scanZstdFrames(buf) {
  const buffer = asBuffer(buf)
  const total = buffer.length
  /** @type {Array<[number, number]>} */
  const frames = []

  let offset = 0
  while (offset < total) {
    const end = scanFrame(buffer, offset)
    // Anything that does not scan cleanly is a half-written tail frame: stop here
    // and leave it for the next round instead of guessing.
    if (end < 0) break
    frames.push([offset, end])
    offset = end
  }

  return frames
}

/**
 * 读一个会话日志文件，返回已解压的 JSONL 文本。
 * - 名字以 .zstd 结尾：逐帧 zstdDecompressSync 后拼接（只用完整帧）
 * - 否则按纯 JSONL：内容截到最后一个 '\n'
 * 读不到/为空都返回 ''（不抛）。
 * @param {string} path
 * @returns {string}
 */
export function readSessionLogSync(path) {
  let raw
  try {
    raw = readFileSync(path)
  } catch {
    return ''
  }
  if (raw.length === 0) return ''

  if (String(path).endsWith('.zstd')) {
    /** @type {Buffer[]} */
    const decoded = []
    for (const [start, end] of scanZstdFrames(raw)) {
      try {
        decoded.push(zstdDecompressSync(raw.subarray(start, end)))
      } catch {
        // A frame that scans but does not decode is corrupted on disk; skip it and
        // keep whatever else the file still holds rather than losing the whole log.
      }
    }
    return Buffer.concat(decoded).toString('utf8')
  }

  // Plain JSONL: the last line may be mid-write, so cut at the last newline.
  const lastNewline = raw.lastIndexOf(0x0a)
  if (lastNewline < 0) return ''
  return raw.subarray(0, lastNewline + 1).toString('utf8')
}
