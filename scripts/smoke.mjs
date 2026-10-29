
// Load the plugin entry exactly as Cordis would, with no DSH packages on the
// module path, and drive it with a fake context.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../lib/index.js')
console.log('name    :', plugin.name)
console.log('Config  :', typeof plugin.Config)
console.log('apply   :', typeof plugin.apply)

const std = plugin.Config['~standard']
console.log('defaults:', JSON.stringify(std.validate({}).value))
console.log('partial :', JSON.stringify(std.validate({ enabled: false, ccSwitchDbPath: '/x.db' }).value))
console.log('garbage :', JSON.stringify(std.validate({ enabled: 'yes', backfillOnStart: 1 }).value))

// Build a temp CC Switch db and a fake Cordis context.
const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
const dbPath = join(dir, 'cc-switch.db')
const { SCHEMA_SQL, assistantMessage, stepStart } = await import('../test/helpers.js')
const db = new DatabaseSync(dbPath); db.exec(SCHEMA_SQL); db.close()

const logs = []
const handlers = []
const ctx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
    debug: () => {},
  },
  on(event, fn) { handlers.push([event, fn]); return () => {} },
  effect(fn, label) { const d = fn(); this._disposers ??= []; this._disposers.push([label, d]); return () => {} },
  _disposers: [],
}

process.env.DSH_HOME = dir   // no sessions dir -> backfill is a no-op
plugin.apply(ctx, std.validate({ ccSwitchDbPath: dbPath, backfillOnStart: false }).value)
console.log('handlers:', handlers.map(([e]) => e).join(','))

// Drive one model call through the real listener.
const emit = handlers.find(([e]) => e === 'session/event')[1]
const session = { id: 'session-smoke' }
emit(session, stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }))
emit(session, assistantMessage({ id: 'smoke-1', turn: 1, step: 1, time: 1_700_000_003_000, input: 200, output: 40, cacheRead: 5000, firstOutputTime: 1_700_000_000_250 }))

// Let the detached drainer finish.
await new Promise((r) => setTimeout(r, 300))

const check = new DatabaseSync(dbPath)
const rows = check.prepare("SELECT * FROM proxy_request_logs WHERE app_type='dsh'").all()
console.log('rows    :', rows.length)
assert.equal(rows.length, 1)
const row = rows[0]
console.log('row     :', JSON.stringify({
  request_id: row.request_id, provider_id: row.provider_id, model: row.model,
  input: row.input_tokens, output: row.output_tokens, cache_read: row.cache_read_tokens,
  latency: row.latency_ms, first_token: row.first_token_ms,
  semantics: row.input_token_semantics, data_source: row.data_source,
  created_at: row.created_at, pricing_model: row.pricing_model, cost: row.total_cost_usd,
}))
const ledger = check.prepare("SELECT COUNT(*) n FROM session_usage_dedup WHERE data_source='dsh_session'").get().n
console.log('ledger  :', ledger)

// Dispose, exactly as Cordis would on unload.
for (const [label, d] of ctx._disposers.reverse()) {
  if (typeof d === 'function') await d()
  console.log('disposed:', label)
}
check.close()
console.log('logs    :', JSON.stringify(logs))
console.log('SMOKE_OK')
