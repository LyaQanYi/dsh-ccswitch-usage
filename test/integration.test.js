// End-to-end: session events -> CC Switch rows, exactly as a live DSH session
// would produce them. Exercises the real modules, not mocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  assistantMessage,
  dedupCount,
  makeDb,
  seedPricing,
  stepStart,
  tempDir,
  usageRows,
  writeSessionsTree,
} from './helpers.js'
import { UsageExtractor } from '../lib/extract.js'
import { backfill } from '../lib/backfill.js'
import { insertUsage, loadPricing, openCcSwitchDb, resolveCcSwitchDbPath } from '../lib/ccswitch-db.js'

const PRICING = { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006, cacheCreate: 0 }

test('a full session folds into CC Switch rows with correct columns', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const extractor = new UsageExtractor('session-abc')
    const events = [
      stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }),
      assistantMessage({ id: 'm1', turn: 1, step: 1, time: 1_700_000_003_000, input: 100, output: 50, cacheRead: 900, firstOutputTime: 1_700_000_000_200 }),
      stepStart({ turn: 1, step: 2, time: 1_700_000_010_000 }),
      assistantMessage({ id: 'm2', turn: 1, step: 2, time: 1_700_000_012_500, input: 20, output: 10, cacheRead: 1_000, provider: 'deepseek-account' }),
    ]
    const records = events.map((event) => extractor.push(event)).filter(Boolean)
    assert.equal(records.length, 2)

    const pricingMap = loadPricing(db)
    for (const record of records) assert.equal(insertUsage(db, record, pricingMap), 'inserted')

    const rows = usageRows(db)
    assert.equal(rows.length, 2)

    const [first, second] = rows
    assert.equal(first.app_type, 'dsh')
    assert.equal(first.data_source, 'dsh_session')
    assert.equal(first.provider_id, '_dsh_session')
    assert.equal(first.model, 'deepseek-v4.1-flash')
    assert.equal(first.input_tokens, 100)
    assert.equal(first.output_tokens, 50)
    assert.equal(first.cache_read_tokens, 900)
    assert.equal(first.cache_creation_tokens, 0)
    assert.equal(first.input_token_semantics, 2)
    assert.equal(first.status_code, 200)
    assert.equal(first.created_at, 1_700_000_003)
    assert.equal(first.latency_ms, 3000)
    assert.equal(first.first_token_ms, 200)
    assert.equal(first.session_id, 'session-abc')

    // DeepSeek-account traffic gets its own placeholder provider.
    assert.equal(second.provider_id, '_dsh_account_session')
    assert.equal(dedupCount(db), 2)

    // Cost uses FRESH input semantics: input_tokens are NOT reduced by cache reads.
    const expectedInput = (100 * 0.3) / 1e6
    assert.equal(Number(first.input_cost_usd).toFixed(12), expectedInput.toFixed(12))
  } finally {
    cleanup()
  }
})

test('replaying the same session never double counts', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const events = [
      stepStart(),
      assistantMessage({ id: 'dup-1' }),
    ]
    const pricingMap = loadPricing(db)

    const runOnce = () => {
      const extractor = new UsageExtractor('session-dup')
      for (const event of events) {
        const record = extractor.push(event)
        if (record) insertUsage(db, record, pricingMap)
      }
    }

    runOnce()
    runOnce()
    runOnce()

    assert.equal(usageRows(db).length, 1)
    assert.equal(dedupCount(db), 1)
  } finally {
    cleanup()
  }
})

test('backfill imports a sessions tree once and is stable on re-run', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = join(dir, 'sessions')
    writeSessionsTree(sessionsRoot, [
      {
        project: '--Users-me-proj-a--',
        session: 'session-aaa',
        frames: true,
        events: [
          stepStart({ time: 1_700_000_000_000 }),
          assistantMessage({ id: 'bf-1', time: 1_700_000_003_000 }),
          stepStart({ turn: 1, step: 2, time: 1_700_000_010_000 }),
          assistantMessage({ id: 'bf-2', turn: 1, step: 2, time: 1_700_000_011_000 }),
        ],
      },
      {
        project: '--Users-me-proj-b--',
        session: 'session-bbb',
        frames: true,
        events: [stepStart(), assistantMessage({ id: 'bf-3' })],
      },
    ])

    const pricingMap = loadPricing(db)
    const first = await backfill({ db, pricingMap, sessionsRoot })
    assert.equal(first.inserted, 3, 'three model calls imported')
    assert.deepEqual(first.errors, [])

    const second = await backfill({ db, pricingMap, sessionsRoot })
    assert.equal(second.inserted, 0, 're-run inserts nothing new')
    assert.equal(usageRows(db).length, 3)
  } finally {
    cleanup()
  }
})

test('resolveCcSwitchDbPath honours explicit path, env, then home default', () => {
  assert.equal(resolveCcSwitchDbPath('/tmp/custom.db', {}), '/tmp/custom.db')
  assert.equal(
    resolveCcSwitchDbPath('', { CC_SWITCH_HOME: '/tmp/ccs-home' }),
    '/tmp/ccs-home/cc-switch.db',
  )
  const fallback = resolveCcSwitchDbPath('', {})
  assert.ok(fallback.endsWith('cc-switch.db'))
  assert.ok(fallback.includes('.cc-switch'))
})

test('a session log with a torn trailing frame still imports its complete frames', async () => {
  const { db, cleanup, dir } = makeDb({ pricing: [PRICING] })
  try {
    const sessionsRoot = join(dir, 'sessions')
    writeSessionsTree(sessionsRoot, [
      {
        project: '--Users-me-proj-c--',
        session: 'session-torn',
        frames: true,
        events: [stepStart(), assistantMessage({ id: 'torn-1' })],
      },
    ])

    // Simulate a half-written trailing frame, as DSH leaves mid-append.
    const { appendFileSync } = await import('node:fs')
    const logPath = join(sessionsRoot, '--Users-me-proj-c--', 'session-torn', 'session.v4.jsonl.zstd')
    appendFileSync(logPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]))

    const result = await backfill({ db, pricingMap: loadPricing(db), sessionsRoot })
    assert.equal(result.inserted, 1, 'the complete frame was still imported')
    assert.equal(usageRows(db).length, 1)
  } finally {
    cleanup()
  }
})

test('missing CC Switch database surfaces a clear error, not a crash', () => {
  const dir = tempDir()
  const missing = join(dir, 'nope.db')
  assert.equal(existsSync(missing), false)
  assert.throws(() => openCcSwitchDb(missing), /CC Switch|no such table|proxy_request_logs/i)
})

test('a database without the expected tables is rejected', () => {
  const dir = tempDir()
  const path = join(dir, 'empty.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE unrelated (x INTEGER)')
    assert.throws(() => openCcSwitchDb(path), /proxy_request_logs/i)
  } finally {
    db.close()
  }
})
