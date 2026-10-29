import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, rmSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'

import { UsageExtractor, extractRecords, parseJsonlLines } from '../lib/extract.js'
import { readSessionLogSync } from '../lib/zstd-frames.js'
import { tempDir, writeSessionLog, assistantMessage, stepStart, jsonlText } from './helpers.js'

const T0 = 1_700_000_000_000
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

/** Feed events through a fresh extractor and keep whatever it produces. */
function run(events, sessionId = 'session-test') {
  const extractor = new UsageExtractor(sessionId)
  const out = []
  for (const event of events) {
    const record = extractor.push(event)
    if (record !== undefined) out.push(record)
  }
  return out
}

describe('UsageExtractor', () => {
  it('turns a step/start + assistant/message pair into one record', () => {
    const records = run([
      stepStart({ turn: 1, step: 3, time: T0 }),
      assistantMessage({ id: 'msg-1', turn: 1, step: 3, time: T0 + 1200, input: 100, output: 50, cacheRead: 900, cacheWrite: 7, firstOutputTime: T0 + 300 }),
    ])
    assert.equal(records.length, 1)
    assert.deepEqual(records[0], {
      requestId: 'dsh:msg-1',
      model: 'deepseek-v4.1-flash',
      sessionId: 'session-test',
      createdAtMs: T0 + 1200,
      latencyMs: 1200,
      firstTokenMs: 300,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 7 },
      viaAccount: false,
    })
  })

  it('keeps input/output/cache counters exactly as DSH reports them (mutex, no subtraction)', () => {
    const [record] = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ turn: 1, step: 1, time: T0 + 500, input: 1870, output: 3660, cacheRead: 102_784 }),
    ])
    assert.equal(record.usage.inputTokens, 1870)
    assert.equal(record.usage.outputTokens, 3660)
    assert.equal(record.usage.cacheReadTokens, 102_784)
    assert.equal(record.usage.cacheWriteTokens, 0)
  })

  it('reports latency 0 when no step/start was seen', () => {
    const [record] = run([assistantMessage({ turn: 2, step: 9, time: T0 + 5000, firstOutputTime: T0 + 4900 })])
    assert.equal(record.latencyMs, 0)
    assert.equal(record.firstTokenMs, null)
  })

  it('pairs step/start by (turn, step), not by arrival order', () => {
    const records = run([
      stepStart({ turn: 1, step: 2, time: T0 }),
      assistantMessage({ id: 'step-1', turn: 1, step: 1, time: T0 + 1000 }),
      assistantMessage({ id: 'step-2', turn: 1, step: 2, time: T0 + 900 }),
    ])
    assert.equal(records.length, 2)
    assert.equal(records[0].latencyMs, 0, 'step 1 never got a step/start')
    assert.equal(records[1].latencyMs, 900)
  })

  it('consumes the step start after a message so a repeated step cannot reuse it', () => {
    const records = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'first', turn: 1, step: 1, time: T0 + 1000 }),
      assistantMessage({ id: 'retry', turn: 1, step: 1, time: T0 + 2000 }),
    ])
    assert.equal(records.length, 2)
    assert.equal(records[0].latencyMs, 1000)
    assert.equal(records[1].latencyMs, 0)
  })

  it('ignores latency outside [100, 3600000] ms', () => {
    const tooFast = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'fast', turn: 1, step: 1, time: T0 + 99, firstOutputTime: T0 + 50 }),
    ])[0]
    assert.equal(tooFast.latencyMs, 0)
    assert.equal(tooFast.firstTokenMs, null)

    const atFloor = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'floor', turn: 1, step: 1, time: T0 + 100, firstOutputTime: T0 + 10 }),
    ])[0]
    assert.equal(atFloor.latencyMs, 100)

    const atCeiling = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'ceiling', turn: 1, step: 1, time: T0 + 3_600_000, firstOutputTime: T0 + 10 }),
    ])[0]
    assert.equal(atCeiling.latencyMs, 3_600_000)

    const tooSlow = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'slow', turn: 1, step: 1, time: T0 + 3_600_001, firstOutputTime: T0 + 10 }),
    ])[0]
    assert.equal(tooSlow.latencyMs, 0)
    assert.equal(tooSlow.firstTokenMs, null)

    // A step/start that happens *after* the message would be negative.
    const backwards = run([
      stepStart({ turn: 1, step: 1, time: T0 + 5000 }),
      assistantMessage({ id: 'back', turn: 1, step: 1, time: T0 }),
    ])[0]
    assert.equal(backwards.latencyMs, 0)
  })

  it('computes firstTokenMs from the earliest stream timestamp', () => {
    const [record] = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({
        turn: 1,
        step: 1,
        time: T0 + 4000,
        firstOutputTime: T0 + 500,
      }),
    ])
    assert.equal(record.firstTokenMs, 500)

    const event = assistantMessage({ turn: 1, step: 2, time: T0 + 8000 })
    event.data.stream = [
      { type: 'chunk', time: T0 + 1200 },
      { type: 'reasoning-chunks', time0: T0 + 900, dt: [5, 5] },
      { type: 'chunk' },
    ]
    const [withReasoning] = run([stepStart({ turn: 1, step: 2, time: T0 }), event])
    assert.equal(withReasoning.firstTokenMs, 900, 'time0 of a packed batch can be earlier than time')
  })

  it('nulls firstTokenMs when it is not in (0, latency]', () => {
    // First output at the step start: zero elapsed time.
    const zero = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'zero', turn: 1, step: 1, time: T0 + 1000, firstOutputTime: T0 }),
    ])[0]
    assert.equal(zero.firstTokenMs, null)

    // First output after the message itself finished: implausible.
    const late = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'late', turn: 1, step: 1, time: T0 + 1000, firstOutputTime: T0 + 4000 }),
    ])[0]
    assert.equal(late.firstTokenMs, null)
    assert.equal(late.latencyMs, 1000, 'a bad first-token estimate must not spoil the latency')

    // Exactly at the latency boundary is still accepted.
    const exact = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'exact', turn: 1, step: 1, time: T0 + 1000, firstOutputTime: T0 + 1000 }),
    ])[0]
    assert.equal(exact.firstTokenMs, 1000)

    // No stream at all.
    const empty = run([
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'plain', turn: 1, step: 1, time: T0 + 1000 }),
    ])[0]
    assert.equal(empty.firstTokenMs, null)
  })

  it('skips messages whose four token counters are all zero', () => {
    const events = [
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ turn: 1, step: 1, time: T0 + 1000, input: 0, output: 0, cacheRead: 0 }),
      stepStart({ turn: 1, step: 2, time: T0 }),
      assistantMessage({ turn: 1, step: 2, time: T0 + 1000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      assistantMessage({ turn: 1, step: 3, time: T0 + 1000, input: 1, output: 0, cacheRead: 0 }),
    ]
    assert.equal(run(events).length, 1)
  })

  it('skips events with no usage object at all', () => {
    const event = assistantMessage({ id: 'no-usage' })
    delete event.data.usage
    assert.equal(run([stepStart({ time: T0 }), event]).length, 0)
    assert.equal(run([{ type: 'assistant/message' }]).length, 0)
    assert.equal(run([{ type: 'assistant/message', data: null }]).length, 0)
  })

  it('defaults a missing cacheWriteTokens to 0 and clamps junk counters to 0', () => {
    const missing = assistantMessage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })
    assert.equal('cacheWriteTokens' in missing.data.usage, false)

    const junk = assistantMessage({ id: 'junk', input: 10, output: 5, cacheRead: -3 })
    junk.data.usage.inputTokens = '120'      // string, not a number
    junk.data.usage.cacheReadTokens = -900   // negative
    junk.data.usage.cacheWriteTokens = 12.5  // fractional
    junk.data.usage.outputTokens = 25        // the only counter left standing

    const records = run([assistantMessage({ id: 'plain', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }), junk])
    assert.deepEqual(records[0].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.deepEqual(records[1].usage, { inputTokens: 0, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.equal(missing.data.usage.cacheWriteTokens, undefined)
  })

  it('derives a stable requestId from the event when the message has no id', () => {
    const event = assistantMessage({ id: '', input: 10, output: 5 })
    delete event.data.message.id
    const copy = JSON.parse(JSON.stringify(event))

    const first = run([event])[0]
    const second = run([event])[0]
    const fromCopy = extractRecords(jsonlText([copy]), 'session-test')[0]
    const fromOtherSession = extractRecords(jsonlText([copy]), 'session-other')[0]

    assert.match(first.requestId, /^dsh:[0-9a-f]{64}$/)
    assert.equal(second.requestId, first.requestId, 'same event twice -> same id')
    assert.equal(fromCopy.requestId, first.requestId, 'fresh parse -> same id')
    assert.equal(fromOtherSession.requestId, first.requestId, 'ids are per event, not per session')
    // A forked session copying the parent's prefix must not double-count it.
    assert.equal(new Set([first.requestId, fromCopy.requestId]).size, 1)
  })

  it('gives different id-less events different requestIds', () => {
    const a = assistantMessage({ id: '', time: T0 + 1 })
    const b = assistantMessage({ id: '', time: T0 + 2 })
    delete a.data.message.id
    delete b.data.message.id
    const [ra, rb] = run([a, b])
    assert.notEqual(ra.requestId, rb.requestId)
  })

  it('falls back to "unknown" when the model id is missing', () => {
    const event = assistantMessage({})
    delete event.data.message.source
    const [record] = run([event])
    assert.equal(record.model, 'unknown')

    const emptyModel = assistantMessage({ model: '' })
    assert.equal(run([emptyModel])[0].model, 'unknown')
  })

  it('flags viaAccount only for the deepseek-account provider', () => {
    const account = run([assistantMessage({ id: 'acc', provider: 'deepseek-account' })])[0]
    const workbuddy = run([assistantMessage({ id: 'wb', provider: 'workbuddy' })])[0]
    const missing = assistantMessage({ id: 'none' })
    delete missing.data.message.source
    assert.equal(account.viaAccount, true)
    assert.equal(workbuddy.viaAccount, false)
    assert.equal(run([missing])[0].viaAccount, false)
  })

  it('ignores unrelated event types and keeps a per-instance session id', () => {
    const extractor = new UsageExtractor('session-abc')
    assert.equal(extractor.push({ type: 'session', id: 'x' }), undefined)
    assert.equal(extractor.push({ type: 'user/message' }), undefined)
    assert.equal(extractor.push(null), undefined)
    assert.equal(extractor.push(undefined), undefined)
    assert.equal(extractor.push('nope'), undefined)
    const record = extractor.push(assistantMessage({ id: 'm' }))
    assert.equal(record.sessionId, 'session-abc')
  })

  it('handles a long session in order, one record per billable step', () => {
    const events = []
    for (let step = 1; step <= 50; step++) {
      events.push(stepStart({ turn: 1, step, time: T0 + step * 10_000 }))
      events.push(assistantMessage({ id: 'm' + step, turn: 1, step, time: T0 + step * 10_000 + 1500, firstOutputTime: T0 + step * 10_000 + 700 }))
    }
    const records = run(events)
    assert.equal(records.length, 50)
    assert.deepEqual(records.map((r) => r.requestId), Array.from({ length: 50 }, (_, i) => 'dsh:m' + (i + 1)))
    assert.deepEqual(records.map((r) => r.latencyMs), Array(50).fill(1500))
    assert.deepEqual(records.map((r) => r.firstTokenMs), Array(50).fill(700))
  })
})

describe('extractRecords', () => {
  it('folds a JSONL string into records', () => {
    const events = [
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'a', turn: 1, step: 1, time: T0 + 800 }),
      stepStart({ turn: 1, step: 2, time: T0 + 10_000 }),
      assistantMessage({ id: 'b', turn: 1, step: 2, time: T0 + 11_000 }),
    ]
    const records = extractRecords(jsonlText(events), 'session-z')
    assert.equal(records.length, 2)
    assert.deepEqual(records.map((r) => r.requestId), ['dsh:a', 'dsh:b'])
    assert.ok(records.every((r) => r.sessionId === 'session-z'))
  })

  it('tolerates blank lines, truncated lines and non-JSON junk', () => {
    const text = [
      '',
      '   ',
      JSON.stringify(stepStart({ turn: 1, step: 1, time: T0 })),
      '{"type":"assistant/message","data":{"usa',       // half-written line
      JSON.stringify(assistantMessage({ id: 'a', turn: 1, step: 1, time: T0 + 900 })),
      'not json at all',
      '',
    ].join('\n')
    const records = extractRecords(text, 'session-bad')
    assert.equal(records.length, 1)
    assert.equal(records[0].requestId, 'dsh:a')
  })

  it('returns [] for empty or non-string input', () => {
    assert.deepEqual(extractRecords('', 's'), [])
    assert.deepEqual(extractRecords(undefined, 's'), [])
    assert.deepEqual(extractRecords(null, 's'), [])
  })
})

describe('parseJsonlLines', () => {
  it('parses one event per line and drops bad lines', () => {
    const events = [stepStart({ time: T0 }), assistantMessage({ id: 'a' })]
    const parsed = parseJsonlLines(jsonlText(events) + '{"broken\n\n  \n')
    assert.equal(parsed.length, 2)
    assert.deepEqual(parsed[0], events[0])
    assert.deepEqual(parsed[1], events[1])
  })

  it('returns [] for empty input', () => {
    assert.deepEqual(parseJsonlLines(''), [])
    assert.deepEqual(parseJsonlLines(null), [])
    assert.deepEqual(parseJsonlLines('\n\n\n'), [])
  })
})

describe('integration with the zstd log reader', () => {
  it('produces the same records from a framed .zstd log as from plain JSONL', () => {
    const events = [
      stepStart({ turn: 1, step: 1, time: T0 }),
      assistantMessage({ id: 'a', turn: 1, step: 1, time: T0 + 900, firstOutputTime: T0 + 200, provider: 'deepseek-account' }),
      { type: 'user/message', time: T0 + 5000, data: { text: 'hi' } },
      stepStart({ turn: 1, step: 2, time: T0 + 20_000 }),
      assistantMessage({ id: 'b', turn: 1, step: 2, time: T0 + 21_000, input: 5, output: 0, cacheRead: 0 }),
      stepStart({ turn: 1, step: 3, time: T0 + 30_000 }),
      assistantMessage({ id: 'c', turn: 1, step: 3, time: T0 + 31_000, input: 0, output: 0, cacheRead: 0 }),
    ]
    const dir = scratch()
    const framed = writeSessionLog(dir, events, { frames: true, batches: [[events[0], events[1]], [events[2], events[3]], [events[4], events[5], events[6]]] })
    const plain = writeSessionLog(dir + '/plain', events, { frames: false })

    const fromFramed = extractRecords(readSessionLogSync(framed), 'session-cc1')
    const fromPlain = extractRecords(readSessionLogSync(plain), 'session-cc1')

    assert.equal(fromFramed.length, 2, 'the all-zero step must not be billed')
    assert.deepEqual(fromFramed, fromPlain)
    assert.deepEqual(fromFramed.map((r) => r.requestId), ['dsh:a', 'dsh:b'])
    assert.equal(fromFramed[0].viaAccount, true)
    assert.equal(fromFramed[0].latencyMs, 900)
    assert.equal(fromFramed[0].firstTokenMs, 200)
  })

  it('keeps the complete frames of a log whose last frame is still being written', () => {
    const events = [stepStart({ turn: 1, step: 1, time: T0 }), assistantMessage({ id: 'a', turn: 1, step: 1, time: T0 + 900 })]
    const dir = scratch()
    const path = writeSessionLog(dir, events, { frames: true })
    assert.equal(extractRecords(readSessionLogSync(path), 's').length, 1)

    // Simulate a writer caught mid-frame.
    const half = zstdCompressSync(Buffer.from(jsonlText([assistantMessage({ id: 'torn' })]) + '\n'))
    appendFileSync(path, half.subarray(0, half.length - 3))
    const records = extractRecords(readSessionLogSync(path), 's')
    assert.equal(records.length, 1)
    assert.equal(records[0].requestId, 'dsh:a')
  })
})
