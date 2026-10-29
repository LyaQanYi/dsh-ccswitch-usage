// Backfill: replay historical DSH session logs into CC Switch.
//
// The important properties are (a) it finds every model call on disk, (b) running
// it again adds nothing, and (c) a broken log costs one error entry, never the
// whole import — a session that crashed mid-write must not stop the plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assistantMessage,
  dedupCount,
  jsonlText,
  makeDb,
  seedPricing,
  stepStart,
  tempDir,
  usageRows,
  writeSessionLog,
  writeSessionsTree,
} from './helpers.js'
import { backfill } from '../lib/backfill.js'
import { loadPricing } from '../lib/ccswitch-db.js'

const PRICING = { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006, cacheCreate: 0 }

/** A two-call session, as a live DSH session would leave it on disk. */
function sessionEvents(ids) {
  return [
    stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }),
    assistantMessage({ id: ids[0], turn: 1, step: 1, time: 1_700_000_003_000 }),
    stepStart({ turn: 1, step: 2, time: 1_700_000_010_000 }),
    assistantMessage({ id: ids[1], turn: 1, step: 2, time: 1_700_000_012_500 }),
  ]
}

test('backfill imports every session log under the sessions root', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-aaa', events: sessionEvents(['bf-1', 'bf-2']) },
      { project: '--Users-me-b--', session: 'session-bbb', events: sessionEvents(['bf-3', 'bf-4']) },
    ])

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.deepEqual(
      { files: result.files, scannedFiles: result.scannedFiles, inserted: result.inserted, skipped: result.skipped },
      { files: 2, scannedFiles: 2, inserted: 4, skipped: 0 },
    )
    assert.deepEqual(result.errors, [])

    const rows = usageRows(db)
    assert.equal(rows.length, 4)
    // The session directory name is the session id, not something out of the file.
    assert.deepEqual([...new Set(rows.map((row) => row.session_id))].sort(), ['session-aaa', 'session-bbb'])
    assert.deepEqual(rows.map((row) => row.request_id).sort(), ['dsh:bf-1', 'dsh:bf-2', 'dsh:bf-3', 'dsh:bf-4'])
    // Timing survives the round trip through the log file.
    const first = rows.find((row) => row.request_id === 'dsh:bf-1')
    assert.equal(first.latency_ms, 3_000)
    assert.equal(first.created_at, 1_700_000_003)
  } finally {
    cleanup()
  }
})

test('backfill reads plain .jsonl logs as well as zstd-framed ones', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = join(dir, 'sessions')
    writeSessionLog(join(sessionsRoot, '--proj--', 'session-plain'), sessionEvents(['p-1', 'p-2']), { frames: false })
    writeSessionLog(join(sessionsRoot, '--proj--', 'session-framed'), sessionEvents(['f-1', 'f-2']), { frames: true })

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.equal(result.inserted, 4)
    assert.deepEqual(result.errors, [])
  } finally {
    cleanup()
  }
})

test('backfill is idempotent across re-runs', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-aaa', events: sessionEvents(['bf-1', 'bf-2']) },
    ])
    const pricingMap = loadPricing(db)
    const state = { files: {} }

    assert.equal((await backfill({ db, pricingMap, sessionsRoot, state })).inserted, 2)
    const second = await backfill({ db, pricingMap, sessionsRoot, state })
    assert.equal(second.inserted, 0, 'a re-run adds no rows')
    assert.equal(second.scannedFiles, 0, 'unchanged files are not even re-read')

    // Force a re-read of the same bytes: the ledger still refuses duplicates.
    const forced = await backfill({ db, pricingMap, sessionsRoot, state: { files: {} } }) // pretend we never saw them
    assert.equal(forced.scannedFiles, 1)
    assert.equal(forced.inserted, 0)
    assert.equal(forced.skipped, 2)

    assert.equal(usageRows(db).length, 2)
    assert.equal(dedupCount(db), 2)
  } finally {
    cleanup()
  }
})

test('backfill skips files whose mtime and size are unchanged', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-aaa', events: sessionEvents(['bf-1', 'bf-2']) },
    ])
    const state = { files: {} }
    const pricingMap = loadPricing(db)

    const first = await backfill({ db, pricingMap, sessionsRoot, state })
    assert.equal(first.inserted, 2)
    assert.equal(Object.keys(state.files).length, 1)

    const second = await backfill({ db, pricingMap, sessionsRoot, state })
    assert.equal(second.files, 1, 'still discovered')
    assert.equal(second.scannedFiles, 0, 'but not re-read')
    assert.equal(second.inserted, 0)
  } finally {
    cleanup()
  }
})

test('backfill picks up a session that grew since the last run', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionDir = join(dir, 'sessions', '--Users-me-a--', 'session-live')
    const logPath = writeSessionLog(sessionDir, sessionEvents(['grow-1', 'grow-2']), { frames: false })
    const state = { files: {} }
    const pricingMap = loadPricing(db)
    assert.equal((await backfill({ db, pricingMap, sessionsRoot: join(dir, 'sessions'), state })).inserted, 2)

    // The session keeps running: two more calls land in the log.
    appendFileSync(logPath, jsonlText([
      stepStart({ turn: 1, step: 3, time: 1_700_000_020_000 }),
      assistantMessage({ id: 'grow-3', turn: 1, step: 3, time: 1_700_000_022_000 }),
    ]))
    // Some filesystems keep second-resolution mtimes; nudge it so the change is visible.
    const later = new Date(Date.now() + 5_000)
    utimesSync(logPath, later, later)

    const second = await backfill({ db, pricingMap, sessionsRoot: join(dir, 'sessions'), state })
    assert.equal(second.scannedFiles, 1)
    assert.equal(second.inserted, 1, 'only the new call is added')
    assert.equal(second.skipped, 2, 'the two already-imported calls are skipped')
    assert.equal(usageRows(db).length, 3)
  } finally {
    cleanup()
  }
})

test('corrupt and unrelated files are ignored, not fatal', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-good', events: sessionEvents(['ok-1', 'ok-2']) },
    ])
    // Not a zstd frame at all: the log reader yields nothing rather than throwing,
    // so a half-written or corrupted log is simply "no usage here yet".
    const brokenDir = join(sessionsRoot, '--Users-me-a--', 'session-broken')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all'))
    // Non-session files, and session dirs without a log, are skipped outright.
    writeFileSync(join(sessionsRoot, '--Users-me-a--', 'session-good', 'notes.txt'), 'ignore me')
    mkdirSync(join(sessionsRoot, '--Users-me-a--', 'session-empty'), { recursive: true })
    writeFileSync(join(sessionsRoot, 'stray-file.jsonl'), 'ignore me too')

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.equal(result.files, 2, 'only session.v*.jsonl(.zstd) files are considered')
    assert.equal(result.inserted, 2, 'the healthy session still imports')
    assert.deepEqual(result.errors, [])
    assert.equal(usageRows(db).length, 2)
  } finally {
    cleanup()
  }
})

test('a failing session is recorded in errors and the walk continues', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-a-poisoned', events: sessionEvents(['bad-1', 'ok-1']) },
      { project: '--Users-me-b--', session: 'session-b-healthy', events: sessionEvents(['ok-2', 'ok-3']) },
    ])
    // Fault injection: reject one specific message id at the database boundary.
    db.exec(`
      CREATE TRIGGER poison BEFORE INSERT ON session_usage_dedup
      WHEN NEW.request_id = 'dsh:bad-1'
      BEGIN SELECT RAISE(ABORT, 'poisoned row'); END
    `)

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.equal(result.files, 2)
    assert.equal(result.errors.length, 1, 'exactly one file failed')
    assert.match(result.errors[0], /session-a-poisoned/)
    assert.match(result.errors[0], /poisoned row/)
    assert.equal(result.inserted, 2, 'the healthy session still imports')
    assert.deepEqual(usageRows(db).map((row) => row.request_id).sort(), ['dsh:ok-2', 'dsh:ok-3'])
  } finally {
    cleanup()
  }
})

test('a torn trailing zstd frame still imports the complete frames', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = join(dir, 'sessions')
    const logPath = writeSessionLog(join(sessionsRoot, '--proj--', 'session-torn'), sessionEvents(['torn-1', 'torn-2']), { frames: true })
    // DSH appends frames; a crash mid-append leaves a partial one behind.
    appendFileSync(logPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]))

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.equal(result.inserted, 2)
    assert.deepEqual(result.errors, [])
  } finally {
    cleanup()
  }
})

test('backfill tolerates a missing sessions root', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot: join(dir, 'nope') })
    assert.deepEqual(
      { files: result.files, scannedFiles: result.scannedFiles, inserted: result.inserted, errors: result.errors },
      { files: 0, scannedFiles: 0, inserted: 0, errors: [] },
    )
  } finally {
    cleanup()
  }
})

test('backfill stops promptly when the caller aborts', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-aaa', events: sessionEvents(['ab-1', 'ab-2']) },
      { project: '--Users-me-b--', session: 'session-bbb', events: sessionEvents(['ab-3', 'ab-4']) },
    ])
    const controller = new AbortController()
    controller.abort()

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot, signal: controller.signal })
    assert.equal(result.inserted, 0, 'an aborted run writes nothing')
    assert.equal(usageRows(db).length, 0)
  } finally {
    cleanup()
  }
})

test('backfill prices historical calls with the current pricing table', async () => {
  const { db, cleanup, dir } = makeDb()
  try {
    seedPricing(db, { modelId: 'global-route-model', input: 1, output: 2, cacheRead: 0.1 })
    seedPricing(db, { modelId: 'route-model', input: 1, output: 2, cacheRead: 0.1 })
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      {
        project: '--Users-me-a--',
        session: 'session-priced',
        events: [
          stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }),
          assistantMessage({ id: 'price-1', model: 'route-model', input: 1_000_000, output: 0, cacheRead: 0, time: 1_700_000_003_000 }),
          stepStart({ turn: 1, step: 2, time: 1_700_000_010_000 }),
          assistantMessage({ id: 'price-2', model: 'global:route-model', input: 1_000_000, output: 0, cacheRead: 0, turn: 1, step: 2, time: 1_700_000_013_000 }),
        ],
      },
    ])

    await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    const rows = usageRows(db)
    assert.equal(rows[0].total_cost_usd, '1')
    assert.equal(rows[0].pricing_model, null)
    // The route-prefixed id keeps the raw model but prices (and labels) as the bare name.
    assert.equal(rows[1].model, 'global:route-model')
    assert.equal(rows[1].pricing_model, 'route-model')
    assert.equal(rows[1].total_cost_usd, '1')
  } finally {
    cleanup()
  }
})

test('backfill records an unpriced model with zero cost', async () => {
  const { db, cleanup, dir } = makeDb()
  try {
    const sessionsRoot = writeSessionsTree(join(dir, 'sessions'), [
      { project: '--Users-me-a--', session: 'session-free', events: sessionEvents(['free-1', 'free-2']) },
    ])
    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.equal(result.inserted, 2)
    for (const row of usageRows(db)) {
      assert.deepEqual(
        [row.input_cost_usd, row.output_cost_usd, row.cache_read_cost_usd, row.cache_creation_cost_usd, row.total_cost_usd],
        ['0', '0', '0', '0', '0'],
      )
      assert.ok(row.input_tokens > 0, 'tokens are still recorded')
    }
  } finally {
    cleanup()
  }
})
