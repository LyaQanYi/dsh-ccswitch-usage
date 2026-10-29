// Fold a DSH session log into CC Switch usage records.
//
// Mirrors CC Switch's own DSH importer (`collect_requests` /
// `parse_assistant_message` in `session_usage_dsh.rs`) so the rows this plugin
// writes are byte-identical to the ones the native importer will write later:
// same request_id, same latency/first-token estimate, same "skip zero usage" rule.

import { createHash } from 'node:crypto'

/** Plausible request durations, in ms. Anything outside is treated as "no timing". */
const MIN_PLAUSIBLE_LATENCY_MS = 100
const MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000

/** The provider route that bills the user's own DeepSeek account. */
const ACCOUNT_ROUTE = 'deepseek-account'

/**
 * @typedef {{
 *   requestId: string,
 *   model: string,
 *   sessionId: string,
 *   createdAtMs: number,
 *   latencyMs: number,
 *   firstTokenMs: number | null,
 *   usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number },
 *   viaAccount: boolean,
 * }} UsageRecord
 */

/**
 * Token counters in DSH are mutex-counted: `inputTokens` is only the fresh,
 * uncached input. Anything missing, negative, fractional or non-numeric counts as 0.
 * @param {unknown} value
 * @returns {number}
 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `(turn, step)` key for pairing `step/start` with `assistant/message`. */
function stepKey(turn, step) {
  return `${turn ?? '?'}:${step ?? '?'}`
}

/**
 * Earliest timestamp inside the message's `stream`: `time` is when a chunk was
 * flushed, `time0` is when the packed batch started.
 * @param {unknown} stream
 * @returns {number | undefined}
 */
function firstOutputTime(stream) {
  if (!Array.isArray(stream)) return undefined
  let earliest
  for (const entry of stream) {
    if (!entry || typeof entry !== 'object') continue
    for (const candidate of [entry.time, entry.time0]) {
      const ms = timestamp(candidate)
      if (ms === undefined) continue
      if (earliest === undefined || ms < earliest) earliest = ms
    }
  }
  return earliest
}

/**
 * @param {number} startMs
 * @param {number} endMs
 * @returns {number} plausible latency, or 0 when out of range
 */
function estimatedLatencyMs(startMs, endMs) {
  const latency = endMs - startMs
  if (!Number.isFinite(latency)) return 0
  return latency >= MIN_PLAUSIBLE_LATENCY_MS && latency <= MAX_PLAUSIBLE_LATENCY_MS ? latency : 0
}

/**
 * @param {number} startMs
 * @param {number} firstOutputMs
 * @param {number} latencyMs
 * @returns {number | null}
 */
function estimatedFirstTokenMs(startMs, firstOutputMs, latencyMs) {
  const firstToken = firstOutputMs - startMs
  if (!Number.isFinite(firstToken)) return null
  return firstToken > 0 && firstToken <= latencyMs ? firstToken : null
}

/**
 * `requestId` for a message without an `id`: the fingerprint of the whole event.
 * Stable across runs and across sessions, so a message copied into a forked log
 * still dedups.
 * @param {unknown} event
 * @returns {string}
 */
function fallbackRequestId(event) {
  return 'dsh:' + createHash('sha256').update(JSON.stringify(event) ?? 'null').digest('hex')
}

/**
 * Stateful folder: feed session events in order, get usage records out.
 *
 * It keeps only what a single pass needs — the `(turn, step) → step/start time`
 * table — because a message and its step start can be many lines apart.
 */
export class UsageExtractor {
  /** @param {string} sessionId */
  constructor(sessionId) {
    this.sessionId = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
    /** @type {Map<string, number>} */
    this.stepStarts = new Map()
  }

  /**
   * @param {unknown} event single already-parsed session event
   * @returns {UsageRecord | undefined}
   */
  push(event) {
    if (!event || typeof event !== 'object') return undefined
    const type = event.type

    if (type === 'step/start') {
      const time = timestamp(event.time)
      if (time === undefined) return undefined
      const data = event.data
      if (!data || typeof data !== 'object') return undefined
      this.stepStarts.set(stepKey(data.turn, data.step), time)
      return undefined
    }

    if (type === 'assistant/message') return this.parseAssistantMessage(event)

    return undefined
  }

  /**
   * @param {any} event
   * @returns {UsageRecord | undefined}
   */
  parseAssistantMessage(event) {
    const data = event.data
    if (!data || typeof data !== 'object') return undefined
    const usage = data.usage
    if (!usage || typeof usage !== 'object') return undefined

    const inputTokens = tokenCount(usage.inputTokens)
    const outputTokens = tokenCount(usage.outputTokens)
    const cacheReadTokens = tokenCount(usage.cacheReadTokens)
    const cacheWriteTokens = tokenCount(usage.cacheWriteTokens)
    // A turn that never reached the model (aborted, empty completion) carries no
    // usage worth recording.
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
      return undefined
    }

    const createdAtMs = timestamp(event.time)
    if (createdAtMs === undefined) return undefined

    const message = data.message && typeof data.message === 'object' ? data.message : undefined
    const source = message?.source && typeof message.source === 'object' ? message.source : undefined

    const messageId = typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined
    const model = typeof source?.model === 'string' && source.model.length > 0 ? source.model : 'unknown'
    const viaAccount = source?.provider === ACCOUNT_ROUTE

    const key = stepKey(data.turn, data.step)
    const stepStart = this.stepStarts.get(key)
    const latencyMs = stepStart === undefined || stepStart === null ? 0 : estimatedLatencyMs(stepStart, createdAtMs)
    const firstOutput = firstOutputTime(data.stream)
    const firstTokenMs =
      stepStart !== undefined && firstOutput !== undefined && latencyMs > 0
        ? estimatedFirstTokenMs(stepStart, firstOutput, latencyMs)
        : null
    // Consume the step start: one step yields at most one billable message.
    this.stepStarts.delete(key)

    return {
      requestId: messageId === undefined ? fallbackRequestId(event) : `dsh:${messageId}`,
      model,
      sessionId: this.sessionId,
      createdAtMs,
      latencyMs,
      firstTokenMs,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
      viaAccount,
    }
  }
}

/**
 * 把整段 JSONL 文本折成一串 UsageRecord。
 * @param {string} jsonlText
 * @param {string} sessionId
 * @returns {UsageRecord[]}
 */
export function extractRecords(jsonlText, sessionId) {
  const extractor = new UsageExtractor(sessionId)
  /** @type {UsageRecord[]} */
  const records = []
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return records
  for (const event of parseJsonlLines(jsonlText)) {
    const record = extractor.push(event)
    if (record !== undefined) records.push(record)
  }
  return records
}

/**
 * 把 JSONL 文本解析成事件数组，坏行直接丢弃（会话日志可能被截断或写坏）。
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseJsonlLines(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  /** @type {unknown[]} */
  const events = []
  for (const line of text.split('\n')) {
    if (!line || line.trim().length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Truncated / corrupted line: not something we can bill for.
    }
  }
  return events
}
