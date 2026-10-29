// Write DSH token usage into CC Switch's own SQLite database.
//
// Every value this module stores is a 1:1 port of CC Switch's own DSH importer
// (`session_usage_dsh.rs`, master), so a row written by this plugin and a row
// written later by CC Switch itself are the *same* row: same `request_id`,
// same `session_usage_dedup` ledger entry, same app/provider/data-source strings.
// Both sides use INSERT OR IGNORE, so whichever runs second quietly skips.
//
// Two consequences worth knowing before editing anything here:
//
// 1. DSH reports *fresh* input tokens (`inputTokens` excludes cache reads and
//    writes), so rows are stamped `input_token_semantics = 2` (FRESH) and the
//    input cost must NOT subtract cache reads — DSH already did that.
//    ('dsh' is deliberately absent from CC Switch's CACHE_INCLUSIVE_APP_TYPES.)
//
// 2. Cost columns are TEXT holding Decimal strings. They must stay plain decimal
//    notation (`0.0000003`, never `3e-7`) because CC Switch parses them into
//    rust_decimal and the dashboard rounds them; an exponent would poison both.
//
// See docs/CONTRACT.md for the frozen signatures.

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `proxy_request_logs.app_type` written for every imported DSH call. */
export const APP_TYPE = 'dsh'
/** `session_usage_dedup.data_source` / `proxy_request_logs.data_source`. */
export const DATA_SOURCE = 'dsh_session'
/** Placeholder provider for requests made through a plain API-key provider. */
export const PROVIDER_ID = '_dsh_session'
/** `proxy_request_logs.provider_type` for the API-key placeholder above. */
export const PROVIDER_TYPE = 'dsh_session'
/** Placeholder provider for traffic routed through the DeepSeek OAuth account. */
export const ACCOUNT_PROVIDER_ID = '_dsh_account_session'
/** `proxy_request_logs.provider_type` for the account placeholder above. */
export const ACCOUNT_PROVIDER_TYPE = 'dsh_account_session'
/** `input_token_semantics` value meaning "input_tokens are fresh input". */
export const INPUT_TOKEN_SEMANTICS_FRESH = 2
/** SQLite lock wait, matching what CC Switch tolerates on its own database. */
export const BUSY_TIMEOUT_MS = 5000

/** Trailing marker some Claude Desktop ids carry; CC Switch strips it before pricing. */
const ONE_M_CONTEXT_MARKER = '[1m]'
/** Namespaces CC Switch peels off before looking a model up in `model_pricing`. */
const KNOWN_NAMESPACES = ['openai.', 'anthropic.', 'google.', 'moonshot.', 'moonshotai.', 'bedrock.', 'global.']
/** Reasoning-effort suffixes CC Switch peels off before looking a model up. */
const REASONING_EFFORT_SUFFIXES = ['-minimal', '-low', '-medium', '-high', '-xhigh']

/**
 * Locate `cc-switch.db`.
 *
 * An explicit path always wins (it is what the user configured). Otherwise
 * `$CC_SWITCH_HOME` — CC Switch's own portable-mode override — then the default
 * `~/.cc-switch` directory. Mirrors CC Switch's directory resolution so a user
 * who moved their data keeps working without configuration.
 *
 * @param {string} [explicitPath] configured path, '' or undefined to fall through.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {string} absolute path to the database file.
 */
export function resolveCcSwitchDbPath(explicitPath, env = process.env) {
  const configured = typeof explicitPath === 'string' ? explicitPath.trim() : ''
  if (configured.length > 0) return configured
  const home = env?.CC_SWITCH_HOME
  if (typeof home === 'string' && home.trim().length > 0) return join(home.trim(), 'cc-switch.db')
  return join(homedir(), '.cc-switch', 'cc-switch.db')
}

/**
 * Open the CC Switch database for writing.
 *
 * `journal_mode=delete` (no WAL) means writers block each other, so the busy
 * timeout is mandatory rather than cosmetic: without it a concurrent CC Switch
 * write turns into an instant SQLITE_BUSY. A database that cannot be opened, or
 * that has no `proxy_request_logs` table, is not a CC Switch database — throw
 * instead of silently creating tables inside whatever file we were pointed at.
 *
 * @param {string} path
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openCcSwitchDb(path) {
  let db
  try {
    db = new DatabaseSync(path)
  } catch (error) {
    throw new Error('cannot open CC Switch database at ' + path + ': ' + messageOf(error), { cause: error })
  }
  try {
    db.exec('PRAGMA busy_timeout = ' + BUSY_TIMEOUT_MS)
    // Force a real read so a missing file/schema fails here, not on first write.
    db.prepare('SELECT 1 FROM proxy_request_logs LIMIT 1').get()
  } catch (error) {
    try { db.close() } catch { /* already gone */ }
    throw new Error(
      'not a CC Switch database (no proxy_request_logs table) at ' + path + ': ' + messageOf(error),
      { cause: error },
    )
  }
  return db
}

/**
 * Read the whole `model_pricing` table into memory.
 *
 * Keyed by lowercased `model_id` because CC Switch matches model ids with
 * COLLATE NOCASE; the map is loaded once and reused per write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, {input: string, output: string, cacheRead: string, cacheCreate: string}>}
 *   prices are per **million** tokens, as decimal strings.
 */
export function loadPricing(db) {
  const map = new Map()
  const rows = db.prepare(
    `SELECT model_id, input_cost_per_million, output_cost_per_million,
            cache_read_cost_per_million, cache_creation_cost_per_million
       FROM model_pricing`,
  ).all()
  for (const row of rows) {
    const key = String(row.model_id ?? '').trim().toLowerCase()
    if (key.length === 0 || map.has(key)) continue
    map.set(key, {
      input: String(row.input_cost_per_million ?? '0'),
      output: String(row.output_cost_per_million ?? '0'),
      cacheRead: String(row.cache_read_cost_per_million ?? '0'),
      cacheCreate: String(row.cache_creation_cost_per_million ?? '0'),
    })
  }
  return map
}

/**
 * Normalise a raw model id the way CC Switch does before pricing.
 *
 * Order matters: take the last `/` segment, cut at the first `:` (the DSH
 * `<route>:<model>` prefix), trim, turn `@` into `-`, lowercase, then drop a
 * trailing `[1m]`.
 *
 * @param {string} modelId
 * @returns {string}
 */
function cleanModelIdForPricing(modelId) {
  const raw = typeof modelId === 'string' ? modelId : ''
  const afterSlash = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  const colon = afterSlash.indexOf(':')
  const beforeColon = colon === -1 ? afterSlash : afterSlash.slice(0, colon)
  let normalized = beforeColon.trim().replaceAll('@', '-').toLowerCase()
  while (normalized.endsWith(ONE_M_CONTEXT_MARKER)) {
    normalized = normalized.slice(0, -ONE_M_CONTEXT_MARKER.length)
  }
  return normalized.trim()
}

/** @param {string} modelId @returns {boolean} whether the id is a placeholder, not a model. */
function isPlaceholderModelId(modelId) {
  return modelId.length === 0 || modelId === 'unknown' || modelId === 'null' || modelId === 'none'
}

/**
 * Build the ordered list of ids to try in `model_pricing`, best first.
 *
 * Mirrors CC Switch's `model_pricing_candidates`: the cleaned id, then ids with
 * a known namespace / provider prefix / version or date suffix / reasoning
 * effort suffix peeled off. This is what makes `deepseek-v4.1-flash-20250615`
 * (and `global.deepseek-v4.1-flash`) price as `deepseek-v4.1-flash`. The
 * `<route>:` form is handled separately in resolvePricing — CC Switch cleans a
 * colon id by taking the part *before* the colon, so it needs an explicit strip.
 *
 * @param {string} modelId
 * @returns {string[]}
 */
function modelPricingCandidates(modelId) {
  const cleaned = cleanModelIdForPricing(modelId)
  if (isPlaceholderModelId(cleaned)) return []

  const candidates = []
  const seen = new Set()
  const queue = [cleaned]
  while (queue.length > 0) {
    const candidate = queue.pop()
    if (candidate.length === 0 || seen.has(candidate)) continue
    seen.add(candidate)
    candidates.push(candidate)

    const namespace = stripKnownNamespace(candidate)
    if (namespace) queue.push(namespace)
    const bedrock = stripBedrockVersionSuffix(candidate)
    if (bedrock) queue.push(bedrock)
    const dated = stripModelDateSuffix(candidate)
    if (dated) queue.push(dated)
    const effort = stripReasoningEffortSuffix(candidate)
    if (effort) queue.push(effort)
    if (candidate.startsWith('claude-') && candidate.includes('.')) queue.push(candidate.replaceAll('.', '-'))
  }
  return candidates
}

/** @param {string} modelId @returns {string|undefined} */
function stripKnownNamespace(modelId) {
  const claude = modelId.lastIndexOf('claude-')
  if (claude > 0) return modelId.slice(claude)
  for (const marker of KNOWN_NAMESPACES) {
    if (modelId.startsWith(marker)) return modelId.slice(marker.length)
  }
  return undefined
}

/** @param {string} modelId @returns {string|undefined} e.g. `foo-v2` -> `foo` */
function stripBedrockVersionSuffix(modelId) {
  const at = modelId.lastIndexOf('-v')
  if (at <= 0) return undefined
  const base = modelId.slice(0, at)
  const suffix = modelId.slice(at + 2)
  if (base.length === 0 || suffix.length === 0) return undefined
  if (!/^\d+$/.test(suffix)) return undefined
  return base
}

/** @param {string} modelId @returns {string|undefined} e.g. `gpt-4o-2024-11-20` -> `gpt-4o` */
function stripModelDateSuffix(modelId) {
  if (modelId.length > 11) {
    const suffix = modelId.slice(-11)
    if (/^\d{4}-\d{2}-\d{2}$/.test(suffix.slice(1)) && suffix.startsWith('-')) {
      return modelId.slice(0, -11)
    }
  }
  const at = modelId.lastIndexOf('-')
  if (at <= 0) return undefined
  const base = modelId.slice(0, at)
  const suffix = modelId.slice(at + 1)
  if (base.length === 0 || !/^\d+$/.test(suffix)) return undefined
  // 8 digits: YYYYMMDD. 6 digits: YYMMDD, only when it parses as a real date.
  if (suffix.length === 8) return base
  if (suffix.length === 6) {
    const month = Number(suffix.slice(2, 4))
    const day = Number(suffix.slice(4, 6))
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return base
  }
  return undefined
}

/** @param {string} modelId @returns {string|undefined} e.g. `gpt-5-high` -> `gpt-5` */
function stripReasoningEffortSuffix(modelId) {
  for (const suffix of REASONING_EFFORT_SUFFIXES) {
    if (modelId.endsWith(suffix) && modelId.length > suffix.length) {
      return modelId.slice(0, -suffix.length)
    }
  }
  return undefined
}

/**
 * Find the price to bill a model at.
 *
 * Returns the pricing entry plus the id it matched on (`pricedAs`), so the caller
 * can price and label a row consistently. No match -> `pricing: undefined`, i.e.
 * "record the tokens, charge nothing" — never guess.
 *
 * @param {Map<string, {input: string, output: string, cacheRead: string, cacheCreate: string}>} pricingMap
 * @param {string} model
 * @returns {{pricedAs: string, pricing: {input: string, output: string, cacheRead: string, cacheCreate: string}|undefined}}
 */
export function resolvePricing(pricingMap, model) {
  const direct = lookupPricing(pricingMap, model)
  if (direct !== undefined) return direct
  // CC Switch's own model_pricing_candidates() cleans the id by taking the part
  // *before* the first ':' — so 'global:deepseek-v4.1-flash' is looked up as
  // 'global' and misses. Its importer therefore strips the route prefix as a
  // second, explicit step and prices the remainder. Both steps are needed.
  const bare = stripRoutePrefix(model)
  if (bare !== undefined) {
    const stripped = lookupPricing(pricingMap, bare)
    if (stripped !== undefined) return stripped
  }
  return { pricedAs: typeof model === 'string' ? model : '', pricing: undefined }
}

/**
 * One pass of CC Switch's lookup: try each candidate id, best first.
 *
 * @param {Map} pricingMap
 * @param {string} model
 * @returns {{pricedAs: string, pricing: object}|undefined}
 */
function lookupPricing(pricingMap, model) {
  for (const candidate of modelPricingCandidates(model)) {
    const pricing = pricingMap?.get(candidate)
    if (pricing !== undefined) return { pricedAs: candidate, pricing }
  }
  return undefined
}

/**
 * Everything after the first ':' — the DSH `<route>:<model>` prefix removed.
 *
 * @param {string} model
 * @returns {string|undefined} undefined when there is no ':' or nothing follows it.
 */
function stripRoutePrefix(model) {
  const text = typeof model === 'string' ? model : ''
  const colon = text.indexOf(':')
  if (colon === -1) return undefined
  const stripped = text.slice(colon + 1)
  return stripped.length > 0 ? stripped : undefined
}

/**
 * Value for the `pricing_model` column.
 *
 * CC Switch stores the bare model name here when the row was priced under a
 * stripped id. `null` means "the model id as written already prices" (or has no
 * `:` to strip). This matters after the fact: when pricing is added later,
 * CC Switch's own re-pricing pass reads `pricing_model` and would otherwise fall
 * back to `model`, where `clean_model_id_for_pricing` takes everything *before*
 * the colon — `global:new-model` would be looked up as `global` and never priced.
 *
 * Note this is computed from the model id alone, not from whether a price exists
 * today: an unpriced `global:x` still records `x`, so the later backfill hits.
 *
 * @param {string} model
 * @param {Map} pricingMap
 * @returns {string|null}
 */
export function pricingModelColumn(model, pricingMap) {
  if (lookupPricing(pricingMap, model) !== undefined) return null
  return stripRoutePrefix(model) ?? null
}

/**
 * Multiply a token count by a per-million price and render the result.
 *
 * `BigInt` keeps this exact: token counts reach the millions and a naive float
 * product (`300 * 0.3 / 1e6`) lands on `0.00009` only by luck. Decimal strings
 * are scaled to 12 places, then trailing zeros are trimmed but at least one
 * digit is kept (`'0'`, not `''`). No exponent ever appears in the output.
 *
 * @param {number} tokens
 * @param {string} pricePerMillion
 * @returns {string} plain decimal string.
 */
function multiplyCost(tokens, pricePerMillion) {
  const count = toTokenCount(tokens)
  if (count === 0) return '0'
  const [mantissa, fraction = ''] = String(pricePerMillion ?? '0').trim().split('.')
  const digits = (mantissa + fraction).replace(/^[+-]/, '')
  if (!/^\d+$/.test(digits)) return '0'
  const sign = String(pricePerMillion).trim().startsWith('-') ? -1n : 1n
  const product = BigInt(count) * BigInt(digits.replace(/^0+(?=\d)/, '')) * sign
  if (product === 0n) return '0'

  // cost = product / (10^fraction.length * 1e6)
  const scale = fraction.length + 6
  const negative = product < 0n
  const scaled = negative ? -product : product
  const divisor = 10n ** BigInt(scale)
  const whole = (scaled / divisor).toString()
  // Exact, like rust_decimal on the CC Switch side: a price with p decimals and
  // an integer token count yields a cost with at most p + 6 decimals, so nothing
  // is rounded away and trimming zeros changes the value by nothing.
  const rest = (scaled % divisor).toString().padStart(scale, '0').replace(/0+$/, '')
  const text = rest.length > 0 ? whole + '.' + rest : whole
  return negative ? '-' + text : text
}

/**
 * Coerce a token count to a non-negative safe integer; junk becomes 0.
 * Mirrors the Rust importer, which reads these as `u64` and clamps.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toTokenCount(value) {
  if (!Number.isInteger(value) || value <= 0) return 0
  return Math.min(value, 4294967295)
}

/**
 * Coerce a millisecond value to an integer; junk becomes 0.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toMillis(value) {
  return Number.isInteger(value) ? value : 0
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @param {unknown} error
 * @returns {boolean} whether SQLite refused the write because another process held the lock.
 */
function isBusy(error) {
  const message = messageOf(error)
  return message.includes('SQLITE_BUSY') || message.includes('database is locked')
}

/**
 * Cost columns for one record: [input, output, cacheRead, cacheCreate, total].
 *
 * DSH input tokens are FRESH — they exclude cache reads and cache writes — so
 * `input_cost = inputTokens * inputPrice` with no subtraction. (CC Switch only
 * subtracts for its cache-inclusive apps: codex/gemini/grokbuild. 'dsh' is not
 * one, and `input_token_semantics = 2` says so explicitly.)
 *
 * @returns {[string, string, string, string, string]}
 */
function costColumns(pricing, usage) {
  if (pricing === undefined) return ['0', '0', '0', '0', '0']
  const input = multiplyCost(usage.inputTokens, pricing.input)
  const output = multiplyCost(usage.outputTokens, pricing.output)
  const cacheRead = multiplyCost(usage.cacheReadTokens, pricing.cacheRead)
  const cacheCreate = multiplyCost(usage.cacheWriteTokens, pricing.cacheCreate)
  return [input, output, cacheRead, cacheCreate, addDecimals([input, output, cacheRead, cacheCreate])]
}

/**
 * Add plain decimal strings exactly, without going through float.
 *
 * @param {string[]} values
 * @returns {string}
 */
function addDecimals(values) {
  /** @type {bigint[]} */
  let scale = 0
  const parts = values.map((value) => {
    const [whole, fraction = ''] = String(value).split('.')
    scale = Math.max(scale, fraction.length)
    return { whole, fraction }
  })
  let total = 0n
  for (const { whole, fraction } of parts) {
    total += BigInt((whole || '0') + fraction.padEnd(scale, '0'))
  }
  if (total === 0n) return '0'
  const text = total.toString().padStart(scale + 1, '0')
  const whole = text.slice(0, text.length - scale)
  const fraction = text.slice(text.length - scale).replace(/0+$/, '')
  return fraction.length > 0 ? whole + '.' + fraction : whole
}

/**
 * Record one model call. Idempotent.
 *
 * Two writes in one transaction, in the same order as CC Switch's importer:
 *
 * 1. The durable receipt (`session_usage_dedup`). Zero rows changed means this
 *    message id was already imported — from this plugin, from a previous run, or
 *    from CC Switch itself — so the call reported a second time is 'skipped'.
 * 2. The detail row (`proxy_request_logs`), also INSERT OR IGNORE so a leftover
 *    detail row can never raise.
 *
 * A fork copies its parent's prefix into a new session log, so the same message
 * id shows up in two files; keying on `dsh:<message.id>` (not session + id) is
 * what keeps that from double counting.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./extract.js').UsageRecord} record
 * @param {Map} pricingMap
 * @returns {'inserted'|'skipped'}
 * @throws when the database stays locked — the thrown error carries `code: 'SQLITE_BUSY'`.
 */
export function insertUsage(db, record, pricingMap) {
  const usage = {
    inputTokens: toTokenCount(record?.usage?.inputTokens),
    outputTokens: toTokenCount(record?.usage?.outputTokens),
    cacheReadTokens: toTokenCount(record?.usage?.cacheReadTokens),
    cacheWriteTokens: toTokenCount(record?.usage?.cacheWriteTokens),
  }
  const model = typeof record?.model === 'string' && record.model.length > 0 ? record.model : 'unknown'
  const requestId = String(record?.requestId ?? '')
  const viaAccount = record?.viaAccount === true
  const price = resolvePricing(pricingMap, model)
  const pricingModel = pricingModelColumn(model, pricingMap)
  const createdSeconds = Math.floor((Number.isFinite(record?.createdAtMs) ? record.createdAtMs : 0) / 1000)
  const latencyMs = toMillis(record?.latencyMs)
  const firstTokenMs = Number.isInteger(record?.firstTokenMs) ? record.firstTokenMs : null

  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    if (isBusy(error)) throw busyError(error)
    throw error
  }

  try {
    const receipt = db.prepare(
      `INSERT OR IGNORE INTO session_usage_dedup (data_source, request_id, semantic_id, has_entry_id)
       VALUES (?, ?, ?, 1)`,
    ).run(DATA_SOURCE, requestId, requestId)
    if (Number(receipt.changes) === 0) {
      db.exec('COMMIT')
      return 'skipped'
    }

    db.prepare(
      `INSERT OR IGNORE INTO proxy_request_logs (
         request_id, provider_id, app_type, model, request_model, pricing_model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
         latency_ms, first_token_ms, status_code, session_id, provider_type, is_streaming,
         cost_multiplier, created_at, data_source, input_token_semantics
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?, 1, '1', ?, ?, ?)`,
    ).run(
      requestId,
      viaAccount ? ACCOUNT_PROVIDER_ID : PROVIDER_ID,
      APP_TYPE,
      model,
      model,
      pricingModel,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      ...costColumns(price.pricing, usage),
      latencyMs,
      firstTokenMs,
      typeof record?.sessionId === 'string' ? record.sessionId : null,
      viaAccount ? ACCOUNT_PROVIDER_TYPE : PROVIDER_TYPE,
      createdSeconds,
      DATA_SOURCE,
      INPUT_TOKEN_SEMANTICS_FRESH,
    )
    db.exec('COMMIT')
    return 'inserted'
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already gone */ }
    if (isBusy(error)) throw busyError(error)
    throw error
  }
}

/**
 * @param {unknown} cause
 * @returns {Error & {code: 'SQLITE_BUSY'}} an error callers can retry on.
 */
function busyError(cause) {
  const error = new Error('CC Switch database is busy: ' + messageOf(cause), { cause })
  error.code = 'SQLITE_BUSY'
  return error
}
