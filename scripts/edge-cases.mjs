
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL, seedPricing } from '../test/helpers.js'
import { insertUsage, loadPricing, pricingModelColumn, resolvePricing } from '../lib/ccswitch-db.js'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-'))
  const db = new DatabaseSync(join(dir, 'cc-switch.db'))
  db.exec(SCHEMA_SQL)
  return db
}
function rec(over = {}) {
  return {
    requestId: over.requestId ?? 'dsh:edge-1',
    model: over.model ?? 'deepseek-v4.1-flash',
    sessionId: over.sessionId ?? 'session-edge',
    createdAtMs: over.createdAtMs ?? 1_700_000_000_000,
    latencyMs: over.latencyMs ?? 0,
    firstTokenMs: over.firstTokenMs ?? null,
    usage: over.usage ?? { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    viaAccount: over.viaAccount ?? false,
  }
}

const db = freshDb()
seedPricing(db, { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006 })
const pricing = loadPricing(db)

// 1. Minimal 1-token call must not produce exponent notation.
insertUsage(db, rec({ requestId: 'dsh:tiny', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }), pricing)
const tiny = db.prepare("SELECT * FROM proxy_request_logs WHERE request_id='dsh:tiny'").get()
console.log('1 token input cost:', tiny.input_cost_usd, '| total:', tiny.total_cost_usd)
assert.match(tiny.input_cost_usd, /^[\d.]+$/, 'no exponent notation')
assert.equal(Number(tiny.input_cost_usd), 0.0000003)

// 2. Unknown model -> zero cost, but the row still lands.
insertUsage(db, rec({ requestId: 'dsh:unknown-model', model: 'totally-unknown-model-xyz' }), pricing)
const unknown = db.prepare("SELECT * FROM proxy_request_logs WHERE request_id='dsh:unknown-model'").get()
console.log('unknown model cost:', JSON.stringify([unknown.input_cost_usd, unknown.total_cost_usd]), 'pricing_model:', unknown.pricing_model)
assert.equal(unknown.total_cost_usd, '0')

// 3. Route-prefixed model resolves through the ':' fallback.
console.log('global:deepseek-v4.1-flash ->',
  JSON.stringify(resolvePricing(pricing, 'global:deepseek-v4.1-flash')),
  'pricing_model col:', pricingModelColumn('global:deepseek-v4.1-flash', pricing))
assert.ok(resolvePricing(pricing, 'global:deepseek-v4.1-flash').pricing !== undefined)

// 4. Unpriced route-prefixed model still records the bare name for later repricing.
console.log('global:brand-new-model pricing_model col:', pricingModelColumn('global:brand-new-model', pricing))
assert.equal(pricingModelColumn('global:brand-new-model', pricing), 'brand-new-model')

// 5. Huge token counts stay exact (BigInt path) and plain decimals.
insertUsage(db, rec({
  requestId: 'dsh:huge',
  usage: { inputTokens: 12_345_678, outputTokens: 9_876_543, cacheReadTokens: 111_222_333, cacheWriteTokens: 0 },
}), pricing)
const huge = db.prepare("SELECT * FROM proxy_request_logs WHERE request_id='dsh:huge'").get()
console.log('huge total cost:', huge.total_cost_usd)
assert.match(huge.total_cost_usd, /^[\d.]+$/)

// 6. Empty / malformed usage must not throw; tokens clamp to 0 but the row is kept
//    only when the caller decided to record it (extract drops all-zero usage).
insertUsage(db, rec({ requestId: 'dsh:neg', usage: { inputTokens: -5, outputTokens: 3.7, cacheReadTokens: NaN, cacheWriteTokens: undefined } }), pricing)
const neg = db.prepare("SELECT * FROM proxy_request_logs WHERE request_id='dsh:neg'").get()
console.log('clamped tokens:', JSON.stringify([neg.input_tokens, neg.output_tokens, neg.cache_read_tokens, neg.cache_creation_tokens]))
assert.equal(neg.input_tokens, 0)
assert.equal(neg.output_tokens, 0)  // fractional counts are dropped, not rounded
assert.equal(neg.cache_read_tokens, 0)

// 7. firstTokenMs null round-trips as NULL.
assert.equal(neg.first_token_ms, null)

// 8. Same request id twice -> exactly one row and one ledger entry.
const before = db.prepare("SELECT COUNT(*) n FROM proxy_request_logs").get().n
const second = insertUsage(db, rec({ requestId: 'dsh:huge' }), pricing)
const after = db.prepare("SELECT COUNT(*) n FROM proxy_request_logs").get().n
console.log('repeat insert:', second, 'rows before/after:', before, after)
assert.equal(second, 'skipped')
assert.equal(after, before)

// 9. Rollback safety: a forced failure must not leave a ledger row behind.
db.exec("CREATE TRIGGER boom BEFORE INSERT ON proxy_request_logs BEGIN SELECT RAISE(ABORT, 'boom'); END")
let threw = false
try { insertUsage(db, rec({ requestId: 'dsh:boom' }), pricing) } catch { threw = true }
db.exec('DROP TRIGGER boom')
const orphan = db.prepare("SELECT COUNT(*) n FROM session_usage_dedup WHERE request_id='dsh:boom'").get().n
console.log('forced failure threw:', threw, '| orphan ledger rows:', orphan)
assert.ok(threw)
assert.equal(orphan, 0, 'ledger entry rolled back with the row')

// 10. Retry after the trigger is gone succeeds.
console.log('retry after failure:', insertUsage(db, rec({ requestId: 'dsh:boom' }), pricing))

db.close()
console.log('EDGE_CASES_OK')
