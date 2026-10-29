// Import historical DSH session logs into CC Switch.
//
// Walks `<sessionsRoot>/<project>/<session>/session.v<version>.jsonl[.zstd]` and
// replays every completed model call through the same write path the live
// listener uses (`insertUsage`), so backfilled rows are indistinguishable from
// live ones. Re-running is free and safe: the `session_usage_dedup` ledger makes
// every call idempotent, and an unchanged file is not even re-read.
//
// This is the "catch up on everything that happened before the plugin was
// installed" half of the recorder. It runs on startup, in the background, and it
// must never take a session down with it: one unreadable log is recorded in
// `errors` and the walk continues.
//
// See docs/CONTRACT.md for the frozen signature.

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { insertUsage } from './ccswitch-db.js'
import { extractRecords } from './extract.js'
import { readSessionLogSync } from './zstd-frames.js'

/** `session.v4.jsonl` / `session.v12.jsonl.zstd` — a DSH session log, whatever the schema version. */
const SESSION_LOG_PATTERN = /^session\.v\d+\.jsonl(\.zstd)?$/

/** Attempts per record when the database is briefly locked by CC Switch itself. */
const BUSY_RETRIES = 3
/** Backoff between those attempts; short, because a startup backfill is best effort. */
const BUSY_RETRY_MS = 25

/**
 * @typedef {{ mtimeMs: number, size: number, inserted: number }} FileSyncState
 * @typedef {{ files?: Record<string, FileSyncState> }} BackfillState
 * @typedef {{ info?: Function, warn?: Function, debug?: Function }} BackfillLogger
 * @typedef {{
 *   db: import('node:sqlite').DatabaseSync,
 *   pricingMap: Map<string, any>,
 *   sessionsRoot: string,
 *   logger?: BackfillLogger,
 *   state?: BackfillState,
 *   signal?: AbortSignal,
 * }} BackfillOptions
 * @typedef {{
 *   files: number,
 *   scannedFiles: number,
 *   inserted: number,
 *   skipped: number,
 *   errors: string[],
 * }} BackfillResult
 */

/**
 * Import every completed model call found under `sessionsRoot`.
 *
 * `files` counts session logs discovered on disk; `scannedFiles` counts the ones
 * actually read this run (files whose `mtimeMs`/`size` match `state` are trusted
 * and not re-read). `inserted` + `skipped` is the number of model calls found in
 * the files that were read.
 *
 * @param {BackfillOptions} options
 * @returns {Promise<BackfillResult>}
 */
export async function backfill({ db, pricingMap, sessionsRoot, logger, state, signal }) {
  /** @type {BackfillResult} */
  const result = { files: 0, scannedFiles: 0, inserted: 0, skipped: 0, errors: [] }
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) return result

  /** @type {string[]} */
  const logPaths = listSessionLogs(sessionsRoot)
  result.files = logPaths.length

  for (const { path, sessionId } of logPaths) {
    if (signal?.aborted === true) break
    try {
      const stat = statSync(path)
      const previous = state?.files?.[path]
      if (previous !== undefined && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        // Already imported the current contents; the ledger would skip it anyway,
        // but skipping the read keeps a large history from being re-parsed on
        // every startup.
        continue
      }
      result.scannedFiles += 1

      const text = readSessionLogSync(path)
      const records = extractRecords(text, sessionId)
      let inserted = 0
      for (const record of records) {
        if (signal?.aborted === true) break
        if (await writeRecord(db, record, pricingMap)) inserted += 1
        else result.skipped += 1
      }
      result.inserted += inserted

      if (state !== undefined) {
        state.files ??= {}
        state.files[path] = { mtimeMs: stat.mtimeMs, size: stat.size, inserted }
      }
    } catch (error) {
      // One broken log must not stop the walk: record it and move on.
      const message = 'session log ' + path + ': ' + messageOf(error)
      result.errors.push(message)
      logger?.warn?.('dsh-ccswitch-usage backfill: ' + message)
    }
  }

  return result
}

/**
 * Write one extracted record, retrying briefly if CC Switch itself is mid-write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./extract.js').UsageRecord} record
 * @param {Map<string, any>} pricingMap
 * @returns {Promise<boolean>} whether a new row was written.
 */
async function writeRecord(db, record, pricingMap) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return insertUsage(db, record, pricingMap) === 'inserted'
    } catch (error) {
      if (error?.code !== 'SQLITE_BUSY' || attempt >= BUSY_RETRIES) throw error
      await delay(BUSY_RETRY_MS * attempt)
    }
  }
}

/**
 * Enumerate session logs, newest directory last so a stable order is processed.
 *
 * Directory names carry meaning: the project directory is CC Switch's encoded
 * cwd, and the session directory name *is* the session id (`session-<uuid>`).
 * That name is what gets written to `proxy_request_logs.session_id`.
 *
 * @param {string} sessionsRoot
 * @returns {Array<{ path: string, sessionId: string }>}
 */
function listSessionLogs(sessionsRoot) {
  /** @type {Array<{ path: string, sessionId: string }>} */
  const logs = []
  for (const projectDir of readDirectories(sessionsRoot)) {
    for (const sessionDir of readDirectories(projectDir)) {
      const sessionId = basename(sessionDir)
      for (const name of readFileNames(sessionDir)) {
        if (!SESSION_LOG_PATTERN.test(name)) continue
        logs.push({ path: join(sessionDir, name), sessionId })
      }
    }
  }
  logs.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return logs
}

/** @param {string} dir @returns {string[]} absolute subdirectory paths, sorted. */
function readDirectories(dir) {
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    // A missing or unreadable sessions root just means there is no history yet.
    return []
  }
  return names
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .sort()
}

/** @param {string} dir @returns {string[]} file names, sorted. */
function readFileNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
