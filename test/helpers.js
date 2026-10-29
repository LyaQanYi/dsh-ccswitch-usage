// Shared test helpers — signatures frozen by the Lead; both sides depend on them.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/** Minimal CC Switch schema, column-for-column with the real 4.0.x database. */
export const SCHEMA_SQL = `
CREATE TABLE proxy_request_logs (
  request_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  model TEXT NOT NULL,
  request_model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd TEXT NOT NULL DEFAULT '0',
  output_cost_usd TEXT NOT NULL DEFAULT '0',
  cache_read_cost_usd TEXT NOT NULL DEFAULT '0',
  cache_creation_cost_usd TEXT NOT NULL DEFAULT '0',
  total_cost_usd TEXT NOT NULL DEFAULT '0',
  latency_ms INTEGER NOT NULL,
  first_token_ms INTEGER,
  duration_ms INTEGER,
  status_code INTEGER NOT NULL,
  error_message TEXT,
  session_id TEXT,
  provider_type TEXT,
  is_streaming INTEGER NOT NULL DEFAULT 0,
  cost_multiplier TEXT NOT NULL DEFAULT '1.0',
  created_at INTEGER NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'proxy',
  pricing_model TEXT,
  input_token_semantics INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE model_pricing (
  model_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  input_cost_per_million TEXT NOT NULL,
  output_cost_per_million TEXT NOT NULL,
  cache_read_cost_per_million TEXT NOT NULL DEFAULT '0',
  cache_creation_cost_per_million TEXT NOT NULL DEFAULT '0'
);
CREATE TABLE session_usage_dedup (
  data_source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  semantic_id TEXT NOT NULL,
  has_entry_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (data_source, request_id)
);
CREATE TABLE session_log_sync (
  file_path TEXT PRIMARY KEY,
  last_modified INTEGER NOT NULL,
  last_line_offset INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER NOT NULL,
  last_byte_offset INTEGER,
  last_tail_fingerprint INTEGER,
  parser_state TEXT
);
CREATE TABLE providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  PRIMARY KEY (id, app_type)
);
`

/** Create a throwaway directory the caller can put a db / session logs in. */
export function tempDir(prefix = 'dsh-ccswitch-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Build a fresh CC Switch database in a temp dir.
 * @param {{ dir?: string, pricing?: object[] }} [options]
 * @returns {{ path: string, db: import('node:sqlite').DatabaseSync, dir: string, cleanup(): void }}
 */
export function makeDb({ dir = tempDir(), pricing = [] } = {}) {
  const path = join(dir, 'cc-switch.db')
  const db = new DatabaseSync(path)
  db.exec(SCHEMA_SQL)
  for (const row of pricing) seedPricing(db, row)
  return {
    path,
    db,
    dir,
    cleanup() {
      try { db.close() } catch { /* already closed */ }
    },
  }
}

/** Insert one model_pricing row: { modelId, input, output, cacheRead?, cacheCreate? }. */
export function seedPricing(db, { modelId, input, output, cacheRead = 0, cacheCreate = 0 }) {
  db.prepare(
    `INSERT OR REPLACE INTO model_pricing
       (model_id, display_name, input_cost_per_million, output_cost_per_million,
        cache_read_cost_per_million, cache_creation_cost_per_million)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(modelId, modelId, String(input), String(output), String(cacheRead), String(cacheCreate))
}

/** All proxy_request_logs rows for app_type='dsh', oldest first. */
export function usageRows(db) {
  return db.prepare("SELECT * FROM proxy_request_logs WHERE app_type = 'dsh' ORDER BY created_at").all()
}

/** Count dedup ledger rows for the dsh data source. */
export function dedupCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM session_usage_dedup WHERE data_source = 'dsh_session'").get().n
}

/** One JSONL line per event. */
export function jsonlText(events) {
  return events.map((event) => JSON.stringify(event) + '\n').join('')
}

/**
 * Write a DSH session log file.
 * - `frames: false` (default): plain `session.v4.jsonl`, one line per event.
 * - `frames: true`: `session.v4.jsonl.zstd`, one independent zstd frame per event
 *   batch — exactly how DSH's jsonl backend appends.
 * @param {string} dir directory the log is written into (created if absent)
 * @param {unknown[]} events
 * @param {{ frames?: boolean, name?: string, batches?: unknown[][] }} [options]
 * @returns {string} absolute file path
 */
export function writeSessionLog(dir, events, { frames = false, name, batches } = {}) {
  mkdirSync(dir, { recursive: true })
  const filename = name ?? (frames ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl')
  const path = join(dir, filename)
  if (!frames) {
    writeFileSync(path, jsonlText(events))
    return path
  }
  const groups = batches ?? events.map((event) => [event])
  const parts = groups.map((group) => zstdCompressSync(Buffer.from(jsonlText(group), 'utf8')))
  writeFileSync(path, Buffer.concat(parts))
  return path
}

/**
 * Lay out a full `sessions/<project>/<session>/session.v*.` tree and return the
 * sessions root, mirroring DSH's on-disk directory convention.
 * @param {string} root sessions root to create under
 * @param {Array<{ project: string, session: string, events: unknown[], frames?: boolean }>} entries
 * @returns {string} the sessions root
 */
export function writeSessionsTree(root, entries) {
  mkdirSync(root, { recursive: true })
  for (const entry of entries) {
    writeSessionLog(join(root, entry.project, entry.session), entry.events, { frames: entry.frames ?? true })
  }
  return root
}

/** True when a value is a plain decimal string without exponent notation. */
export function isDecimalString(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
}

/**
 * A realistic assistant/message event. Defaults mirror a real DSH log line.
 * @param {{ id?: string, turn?: number, step?: number, time?: number, model?: string,
 *           provider?: string, input?: number, output?: number, cacheRead?: number,
 *           cacheWrite?: number, firstOutputTime?: number }} [overrides]
 */
export function assistantMessage({
  id = 'msg-1',
  turn = 1,
  step = 1,
  time = 1_700_000_003_000,
  model = 'deepseek-v4.1-flash',
  provider = 'workbuddy',
  input = 100,
  output = 50,
  cacheRead = 900,
  cacheWrite = 0,
  firstOutputTime,
} = {}) {
  const usage = { inputTokens: input, outputTokens: output, totalTokens: input + output + cacheRead + cacheWrite, cacheReadTokens: cacheRead }
  if (cacheWrite !== 0) usage.cacheWriteTokens = cacheWrite
  const stream = firstOutputTime === undefined ? [] : [{ type: 'chunk', time: firstOutputTime, chunk: { type: 'block-start', index: 0, blockType: 'text' } }]
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', id, source: { kind: 'model', provider, model }, content: [{ type: 'text', text: 'ok' }] },
      usage,
      stream,
    },
  }
}

/** A step/start event. */
export function stepStart({ turn = 1, step = 1, time = 1_700_000_000_000 } = {}) {
  return { type: 'step/start', time, data: { turn, step } }
}
