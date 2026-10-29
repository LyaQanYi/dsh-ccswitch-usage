/**
 * DSH -> CC Switch usage recorder.
 *
 * Watches the session event feed and writes one row per model call into CC
 * Switch's own SQLite database, so DeepSeek Harness token usage appears in CC
 * Switch's usage dashboard alongside the other CLI apps it already tracks.
 *
 * Design constraints, in order of importance:
 *
 * 1. Never block or break a session. The write path is fully detached: the
 *    session event listener only folds a cheap record and pushes it onto a
 *    queue; a serial drainer does the SQLite work. Every failure is logged and
 *    swallowed - a broken usage recorder must not cost the user a turn.
 *
 * 2. Never double count. Rows carry the exact identity CC Switch's own DSH
 *    importer uses (app_type='dsh', data_source='dsh_session',
 *    request_id='dsh:<message.id>') plus a session_usage_dedup ledger entry.
 *    Re-running this plugin, replaying a session, or upgrading to a CC Switch
 *    build that imports DSH natively all converge on the same rows instead of
 *    adding to them.
 *
 * 3. Stay inert when CC Switch is not installed. No database, no log spam: one
 *    warning, then nothing.
 *
 * @module dsh-ccswitch-usage
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { UsageExtractor } from './extract.js'
import { backfill } from './backfill.js'
import { insertUsage, loadPricing, openCcSwitchDb, resolveCcSwitchDbPath } from './ccswitch-db.js'

/** Cordis plugin identity. */
export const name = 'dsh-ccswitch-usage'

/**
 * Plugin configuration.
 *
 * Declared as a plain Standard Schema (the shape Cordis validates against)
 * instead of importing `@deepseek-ai/schemastery`. A plugin runs inside DSH's
 * own module graph, but keeping this entry module free of non-builtin imports
 * means it also loads under a bare `node` for tests and tooling.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ccswitch-usage',
    /**
     * @param {unknown} value raw user config from the profile patch
     * @returns {{ value: { enabled: boolean, ccSwitchDbPath: string, backfillOnStart: boolean, refreshPricing: boolean } }}
     */
    validate(value) {
      const input = value !== null && typeof value === 'object' ? value : {}
      const read = (key, fallback) => {
        const candidate = input[key]
        if (candidate === undefined || candidate === null) return fallback
        if (typeof candidate !== typeof fallback) return fallback
        return candidate
      }
      return {
        value: {
          enabled: read('enabled', true),
          ccSwitchDbPath: read('ccSwitchDbPath', ''),
          backfillOnStart: read('backfillOnStart', true),
          refreshPricing: read('refreshPricing', true),
        },
      }
    },
  },
}

/** The DSH home directory, honouring `$DSH_HOME` the way the harness itself does. */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** Retry delay for a database that could not be opened (doubles, capped). */
const DB_RETRY_BASE_MS = 15_000
const DB_RETRY_MAX_MS = 5 * 60_000

/** How long a loaded price list is reused before re-reading model_pricing. */
const PRICING_TTL_MS = 60_000

/** Hard cap on the in-memory backlog; older entries are dropped (backfill recovers them). */
const QUEUE_MAX_DEPTH = 10_000

/** Warn once the write queue grows past this depth; a sign the database is locked. */
const QUEUE_WARN_DEPTH = 512

/**
 * Fold one session event and enqueue the resulting database write.
 *
 * Synchronous and allocation-light on purpose: this runs inside the session
 * append path, so anything expensive here delays the user's turn.
 *
 * @param ctx - plugin context (for logging only).
 * @param state - mutable recorder state.
 * @param session - the session the event belongs to; its id keys the folder state.
 * @param event - the committed session event.
 */
function onSessionEvent(ctx, state, session, event) {
  if (!state.enabled) return
  const sessionId = session?.id ?? session?.header?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return

  let extractor = state.extractors.get(sessionId)
  if (extractor === undefined) {
    extractor = new UsageExtractor(sessionId)
    state.extractors.set(sessionId, extractor)
  }

  let record
  try {
    record = extractor.push(event)
  } catch (error) {
    ctx.logger.warn(name + ': failed to fold a session event: ' + String(error))
    return
  }
  if (record === undefined) return

  state.queue.push(record)
  // Cap the backlog: usage is always recoverable from the session log by the next
  // backfill, so dropping the oldest beats unbounded memory growth when CC Switch
  // holds the database locked for a long time.
  if (state.queue.length > QUEUE_MAX_DEPTH) {
    state.queue.shift()
    state.dropped += 1
  }
  if (state.queue.length % QUEUE_WARN_DEPTH === 0) {
    ctx.logger.warn(
      name + ': ' + state.queue.length + ' usage writes are queued; the CC Switch database may be locked' +
        (state.dropped > 0 ? ' (' + state.dropped + ' older record(s) dropped, recoverable by backfill)' : ''),
    )
  }
  void drain(ctx, state)
}

/**
 * Drain the queue serially. Concurrent callers share one in-flight promise, so
 * writes stay ordered and a burst of model calls never opens parallel write
 * transactions against the same SQLite file.
 *
 * @param ctx - plugin context (for logging only).
 * @param state - mutable recorder state.
 */
async function drain(ctx, state) {
  if (state.draining !== undefined) return state.draining
  if (state.queue.length === 0) return undefined
  state.draining = (async () => {
    let settledAny = false
    try {
      while (state.queue.length > 0) {
        const record = state.queue[0]
        // `enabled` gates the listener, not the drain: every queued record was
        // observed while recording was on, so it is still owed a row. In
        // particular, disposal turns recording off to stop new work and then
        // flushes what remains.
        let settled = false
        try {
          const db = await ensureDb(ctx, state, state.disposing === true)
          // The database is temporarily unopenable (CC Switch not running yet, or
          // locked). Keep the record queued instead of dropping it: holding it costs
          // one scalar, and a later drain writes it as soon as CC Switch answers.
          if (db === undefined) break
          insertUsage(db, record, await ensurePricing(ctx, state))
          state.written += 1
          settled = true
        } catch (error) {
          ctx.logger.warn(name + ': failed to record usage for ' + record.requestId + ': ' + String(error))
          if (isClosedDatabaseError(error)) state.db = undefined
          // A rejected row is not retryable; a database-level failure is.
          settled = !isRetryableWriteError(error)
        } finally {
          if (settled) {
            state.queue.shift()
            settledAny = true
          }
        }
        if (!settled) break
      }
    } finally {
      state.draining = undefined
    }
    // Retry only when the queue made progress while we were busy. Without this
    // guard an unopenable database would spin here forever, because the loop
    // bails out with the record still queued.
    if (settledAny && state.queue.length > 0) void drain(ctx, state)
  })()
  return state.draining
}

/**
 * Lazily open and cache the CC Switch database.
 *
 * @param ctx - plugin context (for logging only).
 * @param state - mutable recorder state.
 * @returns the open database, or undefined when CC Switch is not installed.
 */
async function ensureDb(ctx, state, force = false) {
  if (state.db !== undefined) return state.db
  // CC Switch may simply not be running *yet* (or may be mid-write and locked)
  // when DSH starts, so a failed open is retried on a backoff rather than
  // latching the recorder off for the rest of the process lifetime.
  const now = Date.now()
  // A disposal flush is the last chance to write, so it ignores the backoff.
  if (!force && state.dbRetryAt > now) return undefined
  try {
    const path = resolveCcSwitchDbPath(state.ccSwitchDbPath)
    state.db = openCcSwitchDb(path)
    state.pricing = undefined
    state.pricingLoadedAt = 0
    state.dbPath = path
    state.dbFailures = 0
    state.dbRetryAt = 0
    ctx.logger.info(name + ': recording usage into ' + path)
    return state.db
  } catch (error) {
    state.dbFailures += 1
    state.dbRetryAt = now + Math.min(DB_RETRY_MAX_MS, DB_RETRY_BASE_MS * 2 ** (state.dbFailures - 1))
    // Warn once when the problem first appears, then drop to debug: a machine
    // without CC Switch should not fill the log with one line per model call.
    if (state.dbFailures === 1) {
      ctx.logger.warn(
        name + ': CC Switch database unavailable (' + String(error) + '); will keep retrying. ' +
          'Set ccSwitchDbPath if CC Switch keeps its data elsewhere.',
      )
    } else {
      ctx.logger.debug?.(name + ': CC Switch database still unavailable: ' + String(error))
    }
    return undefined
  }
}

/**
 * Load model pricing from the CC Switch database.
 *
 * @param ctx - plugin context (for logging only).
 * @param state - mutable recorder state.
 * @returns the price map keyed by lowercased model id.
 */
async function ensurePricing(ctx, state) {
  const now = Date.now()
  if (state.pricing !== undefined && (!state.refreshPricing || now - state.pricingLoadedAt < PRICING_TTL_MS)) return state.pricing
  if (state.db === undefined) return new Map()
  try {
    state.pricing = loadPricing(state.db)
    state.pricingLoadedAt = now
  } catch (error) {
    ctx.logger.warn(name + ': failed to load model pricing: ' + String(error))
    state.pricing = new Map()
    state.pricingLoadedAt = now
  }
  return state.pricing
}

/**
 * @param error - anything thrown by a SQLite call.
 * @returns whether the cached handle is stale and must be reopened.
 */
/**
 * Whether a failed write is worth retrying later. A locked or closed database is;
 * a row the schema rejected is not.
 *
 * @param error - anything thrown by a SQLite call.
 * @returns whether the record should stay queued.
 */
function isRetryableWriteError(error) {
  if (isClosedDatabaseError(error)) return true
  if (error?.code === 'SQLITE_BUSY') return true
  const message = String(error?.message ?? error)
  return message.includes('database is locked') || message.includes('database table is locked')
}

function isClosedDatabaseError(error) {
  const message = String(error?.message ?? error)
  return (
    message.includes('database is not open') ||
    message.includes('database is closed') ||
    message.includes('Cannot use a closed database') ||
    message.includes('database connection is not open')
  )
}

/** Where the backfill resume state lives; under the DSH home so it travels with the profile. */
function stateFilePath() {
  return join(resolveDshHome(), 'cache', 'dsh-ccswitch-usage', 'backfill-state.json')
}

/**
 * Read the persisted backfill state. A missing or unreadable file is normal —
 * the ledger makes a full re-scan harmless, just slower.
 *
 * @returns {{ files: Record<string, { mtimeMs: number, size: number, inserted: number }> }}
 */
function loadBackfillState(ctx) {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.files === 'object' && parsed.files !== null) {
      return { files: parsed.files }
    }
  } catch { /* first run, or the file was discarded */ }
  return { files: {} }
}

/**
 * Persist the backfill state. Best effort: a read-only home must not break recording.
 *
 * @param ctx - plugin context (for logging only).
 * @param state - the backfill state to save.
 */
function saveBackfillState(ctx, state) {
  try {
    const path = stateFilePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, files: state.files }))
  } catch (error) {
    ctx.logger.debug?.(name + ': could not persist backfill state: ' + String(error))
  }
}

/**
 * Mount the recorder.
 *
 * @param ctx - plugin context providing the session event feed.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const state = {
    enabled: config.enabled !== false,
    ccSwitchDbPath: config.ccSwitchDbPath ?? '',
    refreshPricing: config.refreshPricing !== false,
    extractors: new Map(),
    queue: [],
    draining: undefined,
    db: undefined,
    dbPath: '',
    dropped: 0,
    backfillPromise: undefined,
    backfillAbort: undefined,
    disposing: false,
    dbFailures: 0,
    dbRetryAt: 0,
    pricing: undefined,
    pricingLoadedAt: 0,
    written: 0,
  }

  if (!state.enabled) {
    ctx.logger.info(name + ': disabled by configuration')
    return
  }

  ctx.on('session/event', (session, event) => {
    onSessionEvent(ctx, state, session, event)
  })

  // A closed session's folder is dead weight: drop it so a long-lived DSH process
  // does not retain one step table per session it has ever seen.
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId === 'string') state.extractors.delete(sessionId)
  })

  if (config.backfillOnStart !== false) {
    // Tracked so disposal can wait for it: closing the handle underneath a running
    // backfill would spray 'database is closed' errors and persist a half-written
    // resume state.
    const backfillAbort = new AbortController()
    state.backfillAbort = backfillAbort
    state.backfillPromise = (async () => {
      try {
        const db = await ensureDb(ctx, state)
        if (db === undefined) return
        const resume = loadBackfillState(ctx)
        const result = await backfill({
          db,
          pricingMap: await ensurePricing(ctx, state),
          sessionsRoot: join(resolveDshHome(), 'sessions'),
          logger: ctx.logger,
          state: resume,
          signal: backfillAbort.signal,
        })
        if (backfillAbort.signal.aborted) return
        saveBackfillState(ctx, resume)
        if (result.inserted > 0) {
          ctx.logger.info(
            name + ': backfilled ' + result.inserted + ' historical model calls from ' +
              result.scannedFiles + ' session logs',
          )
        }
        if (result.errors.length > 0) {
          ctx.logger.warn(
            name + ': backfill reported ' + result.errors.length + ' problem(s); first: ' + result.errors[0],
          )
        }
      } catch (error) {
        if (!backfillAbort.signal.aborted) ctx.logger.warn(name + ': backfill failed: ' + String(error))
      } finally {
        state.backfillPromise = undefined
      }
    })()
  }

  // Cordis awaits this disposer on unload: finish the in-flight batch, drain
  // whatever is still queued, then release the handle.
  ctx.effect(() => async () => {
    state.enabled = false
    state.disposing = true
    // Stop the startup import first: it holds the same database handle.
    try { state.backfillAbort?.abort() } catch { /* already aborted */ }
    if (state.backfillPromise !== undefined) {
      try { await state.backfillPromise } catch { /* already logged */ }
    }
    if (state.draining !== undefined) {
      try { await state.draining } catch { /* already logged */ }
    }
    try { await drain(ctx, state) } catch { /* already logged */ }
    // Never lose usage silently. Anything still queued is recoverable from the
    // session log by the next startup backfill, but the user (and the log) should
    // know it happened rather than discovering a gap in the dashboard.
    if (state.queue.length > 0) {
      ctx.logger.warn(
        name + ': ' + state.queue.length + ' usage record(s) could not be written before shutdown; ' +
          'they will be recovered from the session log on the next start.',
      )
    }
    try { state.db?.close() } catch { /* already closed */ }
    state.db = undefined
    state.queue.length = 0
    state.extractors.clear()
  }, 'dsh-ccswitch-usage.flush')
}
