import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'

import { scanZstdFrames, readSessionLogSync } from '../lib/zstd-frames.js'
import { tempDir, writeSessionLog, assistantMessage, stepStart, jsonlText } from './helpers.js'

const ZSTD_MAGIC = 0xfd2fb528
const dirs = []
function scratch() {
  const dir = tempDir()
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir, ignore */ }
  }
})

/**
 * Hand-build one zstd frame so every structural branch of the scanner can be
 * exercised, including ones Node's compressor never emits (multi-segment
 * headers, RLE blocks, reserved bit patterns).
 * @returns {Buffer}
 */
function craftFrame({
  magic = ZSTD_MAGIC,
  reservedBits = false,
  singleSegment = true,
  contentSizeFlag = 0,
  checksum = false,
  dictFlag = 0,
  blockType = 0,
  declaredBlockSize = 0,
  payload = Buffer.alloc(0),
  last = true,
} = {}) {
  const parts = []
  const magicBytes = Buffer.alloc(4)
  magicBytes.writeUInt32LE(magic >>> 0, 0)
  parts.push(magicBytes)

  const descriptor =
    (contentSizeFlag << 6) |
    (singleSegment ? 0x20 : 0) |
    (checksum ? 0x04 : 0) |
    dictFlag |
    (reservedBits ? 0x18 : 0)
  parts.push(Buffer.from([descriptor]))

  if (!singleSegment) parts.push(Buffer.from([0])) // window descriptor
  if (dictFlag === 3) parts.push(Buffer.alloc(4))
  else if (dictFlag > 0) parts.push(Buffer.alloc(dictFlag))
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  if (contentSizeBytes > 0) parts.push(Buffer.alloc(contentSizeBytes))

  const header = declaredBlockSize * 8 + blockType * 2 + (last ? 1 : 0)
  parts.push(Buffer.from([header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff]))
  parts.push(payload)
  if (checksum) parts.push(Buffer.alloc(4))
  return Buffer.concat(parts)
}

describe('scanZstdFrames', () => {
  it('finds one frame per appended event batch, contiguous and covering the file', () => {
    const dir = scratch()
    const events = [stepStart(), assistantMessage({ id: 'a' }), assistantMessage({ id: 'b', step: 2 })]
    const path = writeSessionLog(dir, events, { frames: true, batches: [[events[0]], [events[1]], [events[2]]] })
    const buf = readFileSync(path)

    const frames = scanZstdFrames(buf)
    assert.equal(frames.length, 3)
    assert.deepEqual(frames[0], [0, frames[1][0]])
    assert.equal(frames.at(-1)[1], buf.length)
    for (const [start, end] of frames) assert.ok(end > start)
  })

  it('returns no frames for an empty buffer', () => {
    assert.deepEqual(scanZstdFrames(Buffer.alloc(0)), [])
  })

  it('drops a half-written tail frame but keeps every complete one', () => {
    const dir = scratch()
    const events = Array.from({ length: 4 }, (_, i) => assistantMessage({ id: 'm' + i, step: i + 1 }))
    const path = writeSessionLog(dir, events, { frames: true })
    const complete = readFileSync(path)
    assert.equal(scanZstdFrames(complete).length, 4)
    const completeBoundaries = scanZstdFrames(complete)

    // A writer interrupted mid-append leaves a prefix of the next frame on disk.
    const tornPrefix = zstdCompressSync(Buffer.from(jsonlText([assistantMessage({ id: 'torn' })]), 'utf8'))
    for (let cut = 1; cut < tornPrefix.length; cut++) {
      const withTorn = Buffer.concat([complete, tornPrefix.subarray(0, cut)])
      assert.equal(scanZstdFrames(withTorn).length, 4, 'torn tail of ' + cut + ' bytes must not count')
      assert.equal(scanZstdFrames(withTorn).at(-1)[1], complete.length)
    }
    // Cut anywhere inside the last complete frame and that frame disappears too.
    for (const [start, end] of completeBoundaries) {
      const truncated = scanZstdFrames(complete.subarray(0, end - 1))
      assert.equal(truncated.length, completeBoundaries.filter((f) => f[1] <= end - 1).length)
      assert.ok(truncated.every((f) => f[1] <= end - 1))
      assert.ok(start >= 0)
    }
  })

  it('never reports a frame that runs past a truncated file', () => {
    const dir = scratch()
    const events = Array.from({ length: 5 }, (_, i) => assistantMessage({ id: 'x' + i, step: i + 1 }))
    const path = writeSessionLog(dir, events, { frames: true })
    const buf = readFileSync(path)

    for (let cut = 0; cut <= buf.length; cut++) {
      const frames = scanZstdFrames(buf.subarray(0, cut))
      assert.ok(frames.length <= 5)
      for (const [start, end] of frames) assert.ok(end <= cut, 'frame end ' + end + ' past cut ' + cut)
      for (let i = 1; i < frames.length; i++) assert.equal(frames[i - 1][1], frames[i][0])
    }
    assert.equal(scanZstdFrames(buf.subarray(0, buf.length)).length, 5)
  })

  it('stops at the first byte that is not a frame magic', () => {
    const frame = craftFrame({ declaredBlockSize: 0 })
    const junk = Buffer.from([0, 1, 2, 3, 4, 5])
    assert.deepEqual(scanZstdFrames(Buffer.concat([frame, frame])).length, 2)
    assert.deepEqual(scanZstdFrames(Buffer.concat([frame, junk, frame])), [[0, frame.length]])
    assert.deepEqual(scanZstdFrames(junk), [])
  })

  it('stops when fewer than 4 bytes are left for the next magic', () => {
    const frame = craftFrame({ declaredBlockSize: 0 })
    assert.deepEqual(scanZstdFrames(Buffer.concat([frame, Buffer.from([0x28, 0xb5, 0x2f])])), [[0, frame.length]])
  })

  it('accepts a Uint8Array as well as a Buffer', () => {
    const frame = craftFrame({ declaredBlockSize: 0 })
    assert.deepEqual(scanZstdFrames(new Uint8Array(frame)), [[0, frame.length]])
  })

  it('reads a multi-segment header (window descriptor, no implicit content size)', () => {
    const frame = craftFrame({ singleSegment: false, declaredBlockSize: 4, payload: Buffer.alloc(4) })
    assert.deepEqual(scanZstdFrames(frame), [[0, frame.length]])
    // Same layout but with an explicit 2-byte content-size field.
    const withFcs = craftFrame({ singleSegment: false, contentSizeFlag: 1, declaredBlockSize: 4, payload: Buffer.alloc(4) })
    assert.deepEqual(scanZstdFrames(withFcs), [[0, withFcs.length]])
  })

  it('sizes the content-size field from its flag (2, 4 and 8 bytes)', () => {
    for (const flag of [1, 2, 3]) {
      const frame = craftFrame({ contentSizeFlag: flag, declaredBlockSize: 2, payload: Buffer.alloc(2) })
      const expectedHeader = 4 + 1 + (1 << flag) + 3 + 2
      assert.equal(frame.length, expectedHeader)
      assert.deepEqual(scanZstdFrames(frame), [[0, frame.length]], 'content size flag ' + flag)
    }
  })

  it('skips the 4-byte checksum when the descriptor asks for one', () => {
    const plain = craftFrame({ declaredBlockSize: 3, payload: Buffer.alloc(3) })
    const checked = craftFrame({ checksum: true, declaredBlockSize: 3, payload: Buffer.alloc(3) })
    assert.equal(checked.length, plain.length + 4)
    assert.deepEqual(scanZstdFrames(checked), [[0, checked.length]])
    // Two checksummed frames back to back must not bleed into each other.
    const both = Buffer.concat([checked, checked])
    assert.deepEqual(scanZstdFrames(both), [[0, checked.length], [checked.length, both.length]])
  })

  it('treats an RLE block payload as exactly one byte', () => {
    // Declared size 1000 but an RLE block only carries the repeated byte.
    const frame = craftFrame({ blockType: 1, declaredBlockSize: 1000, payload: Buffer.from([0x41]) })
    assert.deepEqual(scanZstdFrames(frame), [[0, frame.length]])
    assert.equal(frame.length, 4 + 1 + 1 + 3 + 1)
  })

  it('stops at a reserved block type instead of running off the buffer', () => {
    const frame = craftFrame({ blockType: 3, declaredBlockSize: 4, payload: Buffer.alloc(4) })
    assert.deepEqual(scanZstdFrames(frame), [])
    const good = craftFrame({ declaredBlockSize: 0 })
    assert.deepEqual(scanZstdFrames(Buffer.concat([good, frame, good])), [[0, good.length]])
  })

  it('stops at reserved descriptor bits', () => {
    const frame = craftFrame({ reservedBits: true, declaredBlockSize: 0 })
    assert.deepEqual(scanZstdFrames(frame), [])
  })

  it('steps over a 4-byte dictionary id when the dict flag is 3', () => {
    const frame = craftFrame({ dictFlag: 3, declaredBlockSize: 2, payload: Buffer.alloc(2) })
    assert.equal(frame.length, 4 + 1 + 4 + 1 + 3 + 2)
    assert.deepEqual(scanZstdFrames(frame), [[0, frame.length]])
    const smallDict = craftFrame({ dictFlag: 2, declaredBlockSize: 0 })
    assert.deepEqual(scanZstdFrames(smallDict), [[0, smallDict.length]])
  })

  it('walks a multi-block frame until the last-block flag', () => {
    const first = craftFrame({ declaredBlockSize: 4, payload: Buffer.alloc(4), last: false })
    const second = craftFrame({ declaredBlockSize: 2, payload: Buffer.alloc(2) })
    const frame = Buffer.concat([first, second.subarray(4 + 1 + 1)])
    assert.deepEqual(scanZstdFrames(frame), [[0, frame.length]])
  })

  it('counts real frames with a checksum exactly once', () => {
    const frame = zstdCompressSync(Buffer.from('{"type":"x"}\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    assert.deepEqual(scanZstdFrames(frame), [[0, frame.length]])
  })
})

describe('readSessionLogSync', () => {
  const events = [
    stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }),
    assistantMessage({ id: 'a', turn: 1, step: 1 }),
    assistantMessage({ id: 'b', turn: 1, step: 2 }),
  ]

  it('decodes every complete frame and concatenates them in order', () => {
    const dir = scratch()
    const path = writeSessionLog(dir, events, { frames: true })
    assert.equal(readSessionLogSync(path), jsonlText(events))
  })

  it('decodes a file split across several frames', () => {
    const dir = scratch()
    const path = writeSessionLog(dir, events, { frames: true, batches: [[events[0]], [events[1], events[2]]] })
    assert.equal(readSessionLogSync(path), jsonlText(events))
  })

  it('drops bytes from a torn tail frame instead of emitting half a line', () => {
    const dir = scratch()
    const path = writeSessionLog(dir, events, { frames: true })
    const torn = zstdCompressSync(Buffer.from(jsonlText([assistantMessage({ id: 'torn' })]), 'utf8'))
    appendFileSync(path, torn.subarray(0, torn.length - 2))
    assert.equal(readSessionLogSync(path), jsonlText(events))
  })

  it('reads plain JSONL files as-is', () => {
    const dir = scratch()
    const path = writeSessionLog(dir, events, { frames: false })
    assert.equal(readSessionLogSync(path), jsonlText(events))
  })

  it('cuts a plain JSONL file at its last newline', () => {
    const dir = scratch()
    const path = join(dir, 'session.v4.jsonl')
    writeFileSync(path, jsonlText(events) + '{"type":"half-writ')
    assert.equal(readSessionLogSync(path), jsonlText(events))

    const noNewline = join(dir, 'no-newline.jsonl')
    writeFileSync(noNewline, '{"type":"complete"')
    assert.equal(readSessionLogSync(noNewline), '')
  })

  it('returns an empty string for missing, empty or unreadable files', () => {
    const dir = scratch()
    assert.equal(readSessionLogSync(join(dir, 'does-not-exist.zstd')), '')
    assert.equal(readSessionLogSync(join(dir, 'nested', 'missing.jsonl')), '')
    const empty = join(dir, 'empty.zstd')
    writeFileSync(empty, '')
    assert.equal(readSessionLogSync(empty), '')
    const emptyJsonl = join(dir, 'empty.jsonl')
    writeFileSync(emptyJsonl, '')
    assert.equal(readSessionLogSync(emptyJsonl), '')
  })

  it('keeps the complete frames of a file whose last frame is torn', () => {
    const dir = scratch()
    const path = writeSessionLog(dir, events, { frames: true, batches: [[events[0]], [events[1]], [events[2]]] })
    const buf = readFileSync(path)
    const boundary = scanZstdFrames(buf)[0][1]
    writeFileSync(path, Buffer.concat([buf.subarray(0, boundary + 6)]))
    assert.equal(readSessionLogSync(path), jsonlText([events[0]]))
  })
})
