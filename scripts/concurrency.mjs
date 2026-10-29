
// The dangerous real-world case: backfill walks old logs while a live session is
// writing new usage. Both must interleave without SQLITE_BUSY corruption or
// double counting, since they share one DatabaseSync handle.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL, assistantMessage, seedPricing, stepStart, writeSessionsTree } from '../test/helpers.js'
import { backfill } from '../lib/backfill.js'
import { insertUsage, loadPricing } from '../lib/ccswitch-db.js'
import { UsageExtractor } from '../lib/extract.js'

const dir = mkdtempSync(join(tmpdir(), 'conc-'))
const db = new DatabaseSync(join(dir, 'cc-switch.db'))
db.exec(SCHEMA_SQL)
seedPricing(db, { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006 })

const sessionsRoot = join(dir, 'sessions')
const history = []
for (let s = 0; s < 12; s += 1) {
  const events = [stepStart()]
  for (let m = 1; m <= 25; m += 1) {
    events.push({ type: 'step/start', time: 1_700_000_000_000 + m * 10_000, data: { turn: 1, step: m } })
    events.push(assistantMessage({ id: 'hist-' + s + '-' + m, turn: 1, step: m, time: 1_700_000_003_000 + m * 10_000 }))
  }
  history.push({ project: '--p--', session: 'session-hist-' + s, frames: true, events })
}
writeSessionsTree(sessionsRoot, history)

const pricing = loadPricing(db)
const extractor = new UsageExtractor('session-live')

// Kick off the backfill and, concurrently, feed live records through the same db.
const backfillPromise = backfill({ db, pricingMap: pricing, sessionsRoot })
let live = 0
for (let i = 1; i <= 60; i += 1) {
  extractor.push({ type: 'step/start', time: 1_700_000_000_000 + i * 10_000, data: { turn: 1, step: i } })
  const rec = extractor.push(assistantMessage({ id: 'live-' + i, turn: 1, step: i, time: 1_700_000_003_000 + i * 10_000 }))
  if (rec) { insertUsage(db, rec, pricing); live += 1 }
}

const result = await backfillPromise
const total = db.prepare("SELECT COUNT(*) n FROM proxy_request_logs WHERE app_type='dsh'").get().n
const ledger = db.prepare("SELECT COUNT(*) n FROM session_usage_dedup WHERE data_source='dsh_session'").get().n
console.log('backfill inserted:', result.inserted, 'errors:', result.errors.length)
console.log('live inserted    :', live)
console.log('total rows       :', total, '(expected', 12 * 25 + live, ')')
console.log('ledger rows      :', ledger)
assert.equal(total, 12 * 25 + live)
assert.equal(ledger, total, 'every row has exactly one ledger entry')
assert.deepEqual(result.errors, [])

// And a second full pass must add nothing.
const again = await backfill({ db, pricingMap: pricing, sessionsRoot })
console.log('second pass inserted:', again.inserted, 'skipped:', again.skipped)
assert.equal(again.inserted, 0)
assert.equal(db.prepare("SELECT COUNT(*) n FROM proxy_request_logs WHERE app_type='dsh'").get().n, total)
db.close()
console.log('CONCURRENCY_OK')
