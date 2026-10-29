
const DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai'
const { Context, Service } = await import(DSH + '/cordis/lib/index.js')
const plugin = await import('../lib/index.js')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { DatabaseSync } = await import('node:sqlite')
const { SCHEMA_SQL, seedPricing, assistantMessage, stepStart } = await import('../test/helpers.js')

// A real CC Switch database in a temp dir.
const dir = mkdtempSync(join(tmpdir(), 'cordis-full-'))
const dbPath = join(dir, 'cc-switch.db')
const seed = new DatabaseSync(dbPath)
seed.exec(SCHEMA_SQL)
seedPricing(seed, { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006 })
seed.close()

const ctx = new Context()
const logs = []
class StubLogger extends Service {
  constructor(scope) { super(scope, 'logger') }
  info(m) { logs.push(['info', String(m)]) }
  warn(m) { logs.push(['warn', String(m)]) }
  error(m) { logs.push(['error', String(m)]) }
  debug(m) { logs.push(['debug', String(m)]) }
}
await ctx.plugin(StubLogger)

const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
process.env.DSH_HOME = home

const fiber = ctx.plugin(plugin, { ccSwitchDbPath: dbPath, backfillOnStart: false })
await fiber
console.log('mounted, uid =', fiber.uid)

const session = { id: 'cordis-session' }
ctx.emit('session/event', session, stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }))
ctx.emit('session/event', session, assistantMessage({ id: 'cordis-real-1', turn: 1, step: 1, time: 1_700_000_003_000, input: 500, output: 100, cacheRead: 8000, firstOutputTime: 1_700_000_000_400 }))

await new Promise((r) => setTimeout(r, 400))
await fiber.dispose()

const check = new DatabaseSync(dbPath)
const rows = check.prepare("SELECT * FROM proxy_request_logs WHERE app_type='dsh'").all()
console.log('rows written:', rows.length)
for (const row of rows) {
  console.log(' ', JSON.stringify({
    request_id: row.request_id, provider: row.provider_id, model: row.model,
    input: row.input_tokens, output: row.output_tokens, cache_read: row.cache_read_tokens,
    latency: row.latency_ms, first_token: row.first_token_ms,
    semantics: row.input_token_semantics, session: row.session_id, cost: row.total_cost_usd,
  }))
}
console.log('ledger:', check.prepare("SELECT COUNT(*) n FROM session_usage_dedup WHERE data_source='dsh_session'").get().n)
check.close()
console.log('logs:', JSON.stringify(logs))
console.log(rows.length === 1 ? 'CORDIS_FULL_OK' : 'CORDIS_FULL_FAIL')
