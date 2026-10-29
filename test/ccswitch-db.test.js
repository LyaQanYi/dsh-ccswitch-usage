// Write layer: CC Switch database rows.
//
// The numbers asserted here are the ones CC Switch's own DSH importer produces
// (see session_usage_dsh.rs), because a mismatch would mean two different rows
// for the same model call once CC Switch imports DSH natively.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import {
  dedupCount,
  isDecimalString,
  makeDb,
  seedPricing,
  tempDir,
  usageRows,
} from './helpers.js'
import {
  insertUsage,
  loadPricing,
  openCcSwitchDb,
  pricingModelColumn,
  resolveCcSwitchDbPath,
  resolvePricing,
} from '../lib/ccswitch-db.js'

const PRICING = { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006, cacheCreate: 2 }

/** A UsageRecord shaped exactly as lib/extract.js produces it. */
function record(overrides = {}) {
  return {
    requestId: 'dsh:msg-1',
    model: 'deepseek-v4.1-flash',
    sessionId: 'session-abc',
    createdAtMs: 1_700_000_003_000,
    latencyMs: 3_000,
    firstTokenMs: 200,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 },
    viaAccount: false,
    ...overrides,
  }
}

test('resolveCcSwitchDbPath prefers explicit path, then CC_SWITCH_HOME, then ~/.cc-switch', () => {
  assert.equal(resolveCcSwitchDbPath('/tmp/custom.db', {}), '/tmp/custom.db')
  assert.equal(resolveCcSwitchDbPath('/tmp/custom.db', { CC_SWITCH_HOME: '/tmp/home' }), '/tmp/custom.db')
  assert.equal(resolveCcSwitchDbPath('', { CC_SWITCH_HOME: '/tmp/home' }), join('/tmp/home', 'cc-switch.db'))
  assert.equal(resolveCcSwitchDbPath(undefined, { CC_SWITCH_HOME: '/tmp/home' }), join('/tmp/home', 'cc-switch.db'))

  const fallback = resolveCcSwitchDbPath('', {})
  assert.ok(fallback.endsWith(join('.cc-switch', 'cc-switch.db')), fallback)
  // An empty or blank explicit path must fall through, not resolve to the cwd.
  assert.equal(resolveCcSwitchDbPath('   ', { CC_SWITCH_HOME: '/tmp/home' }), join('/tmp/home', 'cc-switch.db'))
})

test('openCcSwitchDb opens a CC Switch database with a busy timeout', () => {
  const { path, cleanup } = makeDb()
  cleanup()
  const db = openCcSwitchDb(path)
  try {
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
  } finally {
    db.close()
  }
})

test('openCcSwitchDb rejects a missing file and a bare sqlite file', () => {
  const dir = tempDir()
  assert.throws(() => openCcSwitchDb(join(dir, 'nope.db')), /CC Switch|proxy_request_logs/i)

  const bare = join(dir, 'bare.db')
  const seed = new DatabaseSync(bare)
  seed.exec('CREATE TABLE unrelated (x INTEGER)')
  seed.close()
  assert.throws(() => openCcSwitchDb(bare), /proxy_request_logs/)
})

test('loadPricing reads every row, keyed by lowercased model id', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    seedPricing(db, { modelId: 'Mixed-Case-Model', input: 1, output: 2 })
    const pricingMap = loadPricing(db)
    assert.equal(pricingMap.size, 2)
    assert.deepEqual(pricingMap.get('deepseek-v4.1-flash'), {
      input: '0.3',
      output: '1.2',
      cacheRead: '0.006',
      cacheCreate: '2',
    })
    assert.ok(pricingMap.has('mixed-case-model'))
  } finally {
    cleanup()
  }
})

test('resolvePricing hits exact ids and strips the DSH <route>: prefix', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)

    const exact = resolvePricing(pricingMap, 'deepseek-v4.1-flash')
    assert.equal(exact.pricedAs, 'deepseek-v4.1-flash')
    assert.equal(exact.pricing.input, '0.3')

    // Unknown model: no price, and pricedAs falls back to the raw id.
    const unknown = resolvePricing(pricingMap, 'totally-unpriced')
    assert.equal(unknown.pricing, undefined)
    assert.equal(unknown.pricedAs, 'totally-unpriced')

    assert.equal(resolvePricing(pricingMap, '').pricing, undefined)
  } finally {
    cleanup()
  }
})

test('pricing_model column records the bare name only when the id had to be stripped', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)

    // Exact hit: the model id as written already prices, so nothing to record.
    assert.equal(pricingModelColumn('deepseek-v4.1-flash', pricingMap), null)
    // Route prefix: record the bare name so a later price backfill can match it.
    assert.equal(pricingModelColumn('global:deepseek-v4.1-flash', pricingMap), 'deepseek-v4.1-flash')
    // No price yet either: the bare name still gets recorded (that is the point).
    assert.equal(pricingModelColumn('global:brand-new-model', pricingMap), 'brand-new-model')
    // Nothing to strip.
    assert.equal(pricingModelColumn('unpriced-model', pricingMap), null)
  } finally {
    cleanup()
  }
})

test('insertUsage writes every column CC Switch expects', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)
    assert.equal(insertUsage(db, record(), pricingMap), 'inserted')

    const rows = usageRows(db)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.request_id, 'dsh:msg-1')
    assert.equal(row.provider_id, '_dsh_session')
    assert.equal(row.provider_type, 'dsh_session')
    assert.equal(row.app_type, 'dsh')
    assert.equal(row.data_source, 'dsh_session')
    assert.equal(row.model, 'deepseek-v4.1-flash')
    assert.equal(row.request_model, 'deepseek-v4.1-flash', 'request_model mirrors model')
    assert.equal(row.pricing_model, null)
    assert.equal(row.input_tokens, 100)
    assert.equal(row.output_tokens, 50)
    assert.equal(row.cache_read_tokens, 900)
    assert.equal(row.cache_creation_tokens, 0)
    assert.equal(row.input_token_semantics, 2, 'DSH input tokens are FRESH input')
    assert.equal(row.status_code, 200)
    assert.equal(row.is_streaming, 1)
    assert.equal(row.cost_multiplier, '1')
    assert.equal(row.created_at, 1_700_000_003, 'createdAtMs truncated to seconds')
    assert.equal(row.latency_ms, 3_000)
    assert.equal(row.first_token_ms, 200)
    assert.equal(row.session_id, 'session-abc')

    // The receipt mirrors the detail row so a native importer agrees it is done.
    const dedup = db.prepare('SELECT * FROM session_usage_dedup').all()
    assert.equal(dedup.length, 1)
    assert.equal(dedup[0].data_source, 'dsh_session')
    assert.equal(dedup[0].request_id, 'dsh:msg-1')
    assert.equal(dedup[0].semantic_id, 'dsh:msg-1')
    assert.equal(dedup[0].has_entry_id, 1)
  } finally {
    cleanup()
  }
})

test('insertUsage bills fresh input without subtracting cache reads', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)
    insertUsage(db, record({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 } }), pricingMap)

    const [row] = usageRows(db)
    // 1M tokens at 0.3 / 1.2 / 0.006 / 2 per million.
    assert.equal(row.input_cost_usd, '0.3')
    assert.equal(row.output_cost_usd, '1.2')
    assert.equal(row.cache_read_cost_usd, '0.006')
    assert.equal(row.cache_creation_cost_usd, '2')
    assert.equal(row.total_cost_usd, '3.506')
    for (const column of ['input_cost_usd', 'output_cost_usd', 'cache_read_cost_usd', 'cache_creation_cost_usd', 'total_cost_usd']) {
      assert.ok(isDecimalString(row[column]), column + ' must be a plain decimal string, got ' + row[column])
    }
  } finally {
    cleanup()
  }
})

test('insertUsage keeps sub-cent costs out of scientific notation', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)
    insertUsage(db, record({ requestId: 'dsh:tiny', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 } }), pricingMap)

    const [row] = usageRows(db)
    assert.equal(row.input_cost_usd, '0.0000003')
    assert.equal(row.output_cost_usd, '0.0000012')
    assert.equal(row.cache_read_cost_usd, '0.000000006')
    for (const column of ['input_cost_usd', 'output_cost_usd', 'cache_read_cost_usd', 'cache_creation_cost_usd', 'total_cost_usd']) {
      assert.ok(isDecimalString(row[column]), column + ' = ' + row[column])
    }
  } finally {
    cleanup()
  }
})

test('an unpriced model records tokens with zero cost', () => {
  const { db, cleanup } = makeDb()
  try {
    const pricingMap = loadPricing(db)
    insertUsage(db, record({ model: 'unpriced-model' }), pricingMap)

    const [row] = usageRows(db)
    assert.equal(row.model, 'unpriced-model')
    assert.equal(row.input_tokens, 100, 'tokens are still recorded')
    assert.deepEqual(
      [row.input_cost_usd, row.output_cost_usd, row.cache_read_cost_usd, row.cache_creation_cost_usd, row.total_cost_usd],
      ['0', '0', '0', '0', '0'],
    )
  } finally {
    cleanup()
  }
})

test('a route-prefixed model prices by its bare name and records pricing_model', () => {
  const { db, cleanup } = makeDb({ pricing: [{ modelId: 'deepseek-v4.1-flash', input: 1, output: 2, cacheRead: 0.1 }] })
  try {
    const pricingMap = loadPricing(db)
    // Same fixture as CC Switch's own test: 1M in / 1M out at 1 and 2 per million.
    insertUsage(db, record({ model: 'global:deepseek-v4.1-flash', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }), pricingMap)

    const [row] = usageRows(db)
    assert.equal(row.model, 'global:deepseek-v4.1-flash', 'model keeps the raw id DSH wrote')
    assert.equal(row.pricing_model, 'deepseek-v4.1-flash')
    assert.equal(row.total_cost_usd, '3')
  } finally {
    cleanup()
  }
})

test('insertUsage is idempotent: the same record twice inserts one row', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)
    assert.equal(insertUsage(db, record(), pricingMap), 'inserted')
    assert.equal(insertUsage(db, record(), pricingMap), 'skipped')
    assert.equal(insertUsage(db, record({ sessionId: 'a-forked-session' }), pricingMap), 'skipped')

    assert.equal(usageRows(db).length, 1)
    assert.equal(dedupCount(db), 1)
  } finally {
    cleanup()
  }
})

test('deepseek-account traffic is filed under its own placeholder provider', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)
    insertUsage(db, record({ requestId: 'dsh:acct', viaAccount: true }), pricingMap)

    const [row] = usageRows(db)
    assert.equal(row.provider_id, '_dsh_account_session')
    assert.equal(row.provider_type, 'dsh_account_session')
    assert.equal(row.app_type, 'dsh', 'still counted as DSH')
  } finally {
    cleanup()
  }
})

test('a record with no first token time stores NULL, not zero', () => {
  const { db, cleanup } = makeDb()
  try {
    const pricingMap = loadPricing(db)
    insertUsage(db, record({ firstTokenMs: null, latencyMs: 0 }), pricingMap)
    const [row] = usageRows(db)
    assert.equal(row.first_token_ms, null)
    assert.equal(row.latency_ms, 0)
  } finally {
    cleanup()
  }
})

test('a failed detail insert rolls the receipt back, so a retry still counts', () => {
  const { db, cleanup } = makeDb({ pricing: [PRICING] })
  try {
    const pricingMap = loadPricing(db)
    db.exec('ALTER TABLE proxy_request_logs RENAME TO proxy_request_logs_gone')
    assert.throws(() => insertUsage(db, record(), pricingMap), /proxy_request_logs/)
    assert.equal(dedupCount(db), 0, 'the receipt must not outlive a failed write')

    db.exec('ALTER TABLE proxy_request_logs_gone RENAME TO proxy_request_logs')
    assert.equal(insertUsage(db, record(), pricingMap), 'inserted')
    assert.equal(usageRows(db).length, 1)
  } finally {
    cleanup()
  }
})

test('a locked database surfaces SQLITE_BUSY so the caller can retry', () => {
  const { db, path, cleanup } = makeDb({ pricing: [PRICING] })
  const locker = new DatabaseSync(path)
  try {
    const pricingMap = loadPricing(db)
    db.exec('PRAGMA busy_timeout = 40')
    locker.exec('BEGIN EXCLUSIVE')
    try {
      assert.throws(
        () => insertUsage(db, record({ requestId: 'dsh:locked' }), pricingMap),
        (error) => error.code === 'SQLITE_BUSY',
      )
    } finally {
      locker.exec('ROLLBACK')
    }
    // The connection is still usable once the lock is gone.
    assert.equal(insertUsage(db, record({ requestId: 'dsh:locked' }), pricingMap), 'inserted')
  } finally {
    try { locker.close() } catch { /* already closed */ }
    cleanup()
  }
})
