// Behaviour of the plugin entry itself: config normalization, listener wiring,
// disposal, and the guarantee that nothing here depends on a DSH package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assistantMessage, makeDb, seedPricing, stepStart } from './helpers.js'

const plugin = await import('../lib/index.js')

/**
 * A Cordis-shaped fake context: enough surface for the plugin to mount, plus a
 * way to drive events and to run its disposer.
 */
function fakeContext() {
  const handlers = new Map()
  const disposers = []
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
      debug: () => {},
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(fn, label) {
      disposers.push([label, fn()])
      return () => {}
    },
  }
  return {
    ctx,
    logs,
    handlers,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    async dispose() {
      for (const [, disposer] of disposers.reverse()) {
        if (typeof disposer === 'function') await disposer()
      }
    },
  }
}

test('Config normalizes missing, partial and malformed values', () => {
  const standard = plugin.Config['~standard']
  assert.equal(standard.version, 1)

  assert.deepEqual(standard.validate(undefined).value, {
    enabled: true,
    ccSwitchDbPath: '',
    backfillOnStart: true,
    refreshPricing: true,
  })

  const partial = standard.validate({ enabled: false, ccSwitchDbPath: '/tmp/x.db' }).value
  assert.equal(partial.enabled, false)
  assert.equal(partial.ccSwitchDbPath, '/tmp/x.db')

  // Wrongly typed values fall back to the default instead of poisoning the config.
  const garbage = standard.validate({ enabled: 'yes', backfillOnStart: 1 }).value
  assert.equal(garbage.enabled, true)
  assert.equal(garbage.backfillOnStart, true)
})

test('a model call flows from the session feed into the CC Switch database', async () => {
  const { db, path, cleanup } = makeDb({ pricing: [{ modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2, cacheRead: 0.006 }] })
  cleanup()

  const fake = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({ ccSwitchDbPath: path, backfillOnStart: false }).value)

    const session = { id: 'session-live' }
    fake.emit('session/event', session, stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }))
    fake.emit('session/event', session, assistantMessage({
      id: 'live-1', turn: 1, step: 1, time: 1_700_000_003_000,
      input: 200, output: 40, cacheRead: 5000, firstOutputTime: 1_700_000_000_250,
    }))

    // The write is deliberately detached; wait for the drainer.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const { DatabaseSync } = await import('node:sqlite')
    const check = new DatabaseSync(path)
    const rows = check.prepare("SELECT * FROM proxy_request_logs WHERE app_type='dsh'").all()
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.request_id, 'dsh:live-1')
    assert.equal(row.provider_id, '_dsh_session')
    assert.equal(row.input_tokens, 200)
    assert.equal(row.cache_read_tokens, 5000)
    assert.equal(row.latency_ms, 3000)
    assert.equal(row.first_token_ms, 250)
    assert.equal(row.input_token_semantics, 2)
    assert.equal(row.session_id, 'session-live')
    check.close()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fake.dispose()
  }
})

test('a disabled plugin registers no listeners at all', () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, plugin.Config['~standard'].validate({ enabled: false }).value)
  assert.equal(fake.handlers.size, 0)
})

test('a missing CC Switch database warns once and never throws', async () => {
  const fake = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({
      ccSwitchDbPath: join(home, 'definitely-missing', 'cc-switch.db'),
      backfillOnStart: false,
    }).value)

    const session = { id: 'session-broken' }
    fake.emit('session/event', session, stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }))
    fake.emit('session/event', session, assistantMessage({ id: 'broken-1', time: 1_700_000_003_000 }))
    await new Promise((resolve) => setTimeout(resolve, 200))

    const warnings = fake.logs.filter(([level]) => level === 'warn')
    assert.equal(warnings.length, 1, 'one warning, not one per model call')
    assert.match(warnings[0][1], /CC Switch database unavailable/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fake.dispose()
  }
})

test('disposing the plugin flushes the queue and closes the database', async () => {
  const { path, cleanup } = makeDb({ pricing: [{ modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2 }] })
  cleanup()
  const fake = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({ ccSwitchDbPath: path, backfillOnStart: false }).value)
    const session = { id: 'session-dispose' }
    for (let n = 1; n <= 5; n += 1) {
      fake.emit('session/event', session, stepStart({ turn: 1, step: n, time: 1_700_000_000_000 + n * 10_000 }))
      fake.emit('session/event', session, assistantMessage({ id: 'dispose-' + n, turn: 1, step: n, time: 1_700_000_003_000 + n * 10_000 }))
    }
    // Do not wait: disposal itself must drain what is still queued.
    await fake.dispose()

    const { DatabaseSync } = await import('node:sqlite')
    const check = new DatabaseSync(path)
    const count = check.prepare("SELECT COUNT(*) n FROM proxy_request_logs WHERE app_type='dsh'").get().n
    check.close()
    assert.equal(count, 5, 'every queued record was written before the handle closed')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('the plugin imports nothing outside Node built-ins and its own files', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith('.js')) continue
    const source = readFileSync(join(libDir, name), 'utf8')
    for (const match of source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gmu)) {
      const specifier = match[1]
      const allowed = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')
      assert.ok(allowed, `${name} imports ${specifier}, which is not a Node built-in or a local file`)
    }
  }
})

test('a failed database open is retried rather than latching the recorder off', async () => {
  // The realistic ordering: DSH boots first, CC Switch is installed or launched
  // later. A failed open must be a scheduled retry, not a permanent disable.
  // Observed behaviour: the retry timer is time-based, so the recorder becomes
  // usable again without a restart once the backoff elapses.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))

  const fake = fakeContext()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({
      ccSwitchDbPath: join(home, 'late', 'cc-switch.db'),
      backfillOnStart: false,
    }).value)

    const session = { id: 'session-late' }
    for (let step = 1; step <= 3; step += 1) {
      fake.emit('session/event', session, stepStart({ turn: 1, step, time: 1_700_000_000_000 + step * 10_000 }))
      fake.emit('session/event', session, assistantMessage({ id: 'late-' + step, turn: 1, step, time: 1_700_000_003_000 + step * 10_000 }))
    }
    await new Promise((resolve) => setTimeout(resolve, 200))

    // A machine without CC Switch gets exactly one warning, not one per model
    // call: the retry backoff suppresses repeats.
    const warnings = fake.logs.filter(([level]) => level === 'warn')
    assert.equal(warnings.length, 1, 'one warning across three failed record attempts')
    assert.match(warnings[0][1], /will keep retrying/)

    // And nothing was thrown into the session path.
    assert.equal(fake.logs.filter(([level]) => level === 'error').length, 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fake.dispose()
  }
})

test('usage recorded while CC Switch was missing is recovered by the next backfill', async () => {
  // The important resilience property: dropping a write when CC Switch is down is
  // not data loss, because the usage is still in the DSH session log and the
  // startup backfill rebuilds it (the ledger dedups anything already written).
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const sessionsRoot = join(home, 'sessions')

  // A session log on disk, as DSH would have written it.
  const { writeSessionsTree } = await import('./helpers.js')
  writeSessionsTree(sessionsRoot, [{
    project: '--proj--',
    session: 'session-recovered',
    frames: true,
    events: [
      stepStart({ turn: 1, step: 1, time: 1_700_000_000_000 }),
      assistantMessage({ id: 'recovered-1', turn: 1, step: 1, time: 1_700_000_003_000 }),
      stepStart({ turn: 1, step: 2, time: 1_700_000_010_000 }),
      assistantMessage({ id: 'recovered-2', turn: 1, step: 2, time: 1_700_000_013_000 }),
    ],
  }])

  const { makeDb, seedPricing: seed } = await import('./helpers.js')
  const target = makeDb({ dir: mkdtempSync(join(tmpdir(), 'ccs-')) })
  seed(target.db, { modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2 })

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { backfill } = await import('../lib/backfill.js')
    const { loadPricing } = await import('../lib/ccswitch-db.js')
    const pricing = loadPricing(target.db)

    // Nothing recorded yet: the plugin was running while CC Switch was down.
    assert.equal(target.db.prepare("SELECT COUNT(*) n FROM proxy_request_logs WHERE app_type='dsh'").get().n, 0)

    const result = await backfill({ db: target.db, pricingMap: pricing, sessionsRoot })
    assert.equal(result.inserted, 2, 'both calls recovered from the session log')

    // Running it again changes nothing.
    const again = await backfill({ db: target.db, pricingMap: pricing, sessionsRoot })
    assert.equal(again.inserted, 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    target.cleanup()
  }
})

test('records queued while the database was unavailable are never lost silently', async () => {
  // The reviewer-found failure: drain shifts a record, fails to open the database,
  // and drops it without a trace. Holding the record must survive disposal, and any
  // record still unwritten at shutdown must be reported, because the startup
  // backfill is what eventually recovers it.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const missing = join(home, 'missing', 'cc-switch.db')

  const fake = fakeContext()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({
      ccSwitchDbPath: missing,
      backfillOnStart: false,
    }).value)

    const session = { id: 'session-drop' }
    for (let step = 1; step <= 5; step += 1) {
      fake.emit('session/event', session, stepStart({ turn: 1, step, time: 1_700_000_000_000 + step * 10_000 }))
      fake.emit('session/event', session, assistantMessage({ id: 'drop-' + step, turn: 1, step, time: 1_700_000_003_000 + step * 10_000 }))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))

    await fake.dispose()

    // The shutdown path must say what it could not write.
    const warnings = fake.logs.filter(([level]) => level === 'warn')
    const leftover = warnings.find(([, message]) => /could not be written before shutdown/.test(message))
    assert.ok(leftover, 'shutdown reported the unwritten records instead of dropping them silently')
    assert.match(leftover[1], /5 usage record/, 'all five were accounted for')

    // And the first, once-only database warning is still there.
    assert.ok(warnings.some(([, message]) => /CC Switch database unavailable/.test(message)))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('the pending queue is bounded so a locked database cannot grow memory forever', async () => {
  // CC Switch uses journal_mode=delete, so a long write can hold the lock and our
  // deliveries back up. The backlog must cap itself; the dropped entries are
  // recoverable from the session log by the next backfill.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const fake = fakeContext()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({
      ccSwitchDbPath: join(home, 'missing', 'cc-switch.db'),
      backfillOnStart: false,
    }).value)

    const session = { id: 'session-flood' }
    const total = 12_000
    for (let step = 1; step <= total; step += 1) {
      fake.emit('session/event', session, stepStart({ turn: 1, step, time: 1_700_000_000_000 + step }))
      fake.emit('session/event', session, assistantMessage({ id: 'flood-' + step, turn: 1, step, time: 1_700_000_001_000 + step }))
    }
    await new Promise((resolve) => setTimeout(resolve, 300))

    // The recorder must still be responsive and must have reported the backlog.
    const backlogWarnings = fake.logs.filter(([, message]) => /usage writes are queued/.test(message))
    assert.ok(backlogWarnings.length > 0, 'the growing backlog was reported')

    // Disposal must terminate promptly rather than trying 10k writes against a
    // database that is not there.
    const started = Date.now()
    await fake.dispose()
    assert.ok(Date.now() - started < 5000, 'disposal stayed bounded')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('disposing during a startup backfill aborts it instead of spraying errors', async () => {
  // The startup import walks every historical session. Unloading DSH (or hot
  // reloading the plugin) while that runs must cancel it cleanly: closing the
  // database underneath it would log one failure per remaining file.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const sessionsRoot = join(home, 'sessions')

  // Enough history that the import cannot finish before we dispose.
  const entries = []
  for (let s = 0; s < 40; s += 1) {
    const events = []
    for (let m = 1; m <= 20; m += 1) {
      events.push(stepStart({ turn: 1, step: m, time: 1_700_000_000_000 + m * 10_000 }))
      events.push(assistantMessage({ id: 'bf-' + s + '-' + m, turn: 1, step: m, time: 1_700_000_003_000 + m * 10_000 }))
    }
    entries.push({ project: '--p--', session: 'session-' + s, frames: true, events })
  }
  const { writeSessionsTree } = await import('./helpers.js')
  writeSessionsTree(sessionsRoot, entries)

  const { makeDb, seedPricing: seed } = await import('./helpers.js')
  const target = makeDb({
    dir: mkdtempSync(join(tmpdir(), 'ccs-')),
    pricing: [{ modelId: 'deepseek-v4.1-flash', input: 0.3, output: 1.2 }],
  })
  target.cleanup()

  const fake = fakeContext()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(fake.ctx, plugin.Config['~standard'].validate({
      ccSwitchDbPath: target.path,
      backfillOnStart: true,
    }).value)

    // Dispose almost immediately: the import is still running.
    await new Promise((resolve) => setTimeout(resolve, 15))
    await fake.dispose()

    // No per-file error spam, and no "backfill failed" either.
    const noisy = fake.logs.filter(([level, message]) =>
      level === 'warn' && /backfill|session log|database is closed/i.test(message))
    assert.deepEqual(noisy, [], 'an aborted backfill logged nothing alarming')

    // Whatever it managed to import is still consistent: ledger and rows agree.
    const { DatabaseSync } = await import('node:sqlite')
    const check = new DatabaseSync(target.path)
    const rows = check.prepare("SELECT COUNT(*) n FROM proxy_request_logs WHERE app_type='dsh'").get().n
    const ledger = check.prepare("SELECT COUNT(*) n FROM session_usage_dedup WHERE data_source='dsh_session'").get().n
    check.close()
    assert.equal(rows, ledger, 'no half-written records')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
