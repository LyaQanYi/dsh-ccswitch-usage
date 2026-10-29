#!/usr/bin/env node
// Dry-run the recorder against a COPY of a real CC Switch database.
//
// Never point this at the live ~/.cc-switch/cc-switch.db: CC Switch keeps the
// file open and a write test against it would show up in the user's dashboard.
// This script copies the database to a temp dir first, then reports exactly what
// the plugin would insert.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { backfill } from '../lib/backfill.js'
import { loadPricing, openCcSwitchDb, resolveCcSwitchDbPath } from '../lib/ccswitch-db.js'

const source = resolveCcSwitchDbPath(process.argv[2] ?? '')
if (!existsSync(source)) {
  console.error('CC Switch database not found at ' + source)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-dryrun-'))
const copy = join(dir, 'cc-switch.db')
copyFileSync(source, copy)
console.log('source:  ' + source)
console.log('copy:    ' + copy)

const db = openCcSwitchDb(copy)
const pricing = loadPricing(db)
console.log('pricing: ' + pricing.size + ' models')

// Match DSH's own home resolution: an explicit DSH_HOME wins over ~/.dsh.
const dshHome = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
console.log('sessions: ' + sessionsRoot)

const started = Date.now()
const result = await backfill({ db, pricingMap: pricing, sessionsRoot })
const elapsed = Date.now() - started

console.log('---')
console.log('scanned files: ' + result.scannedFiles)
console.log('inserted:      ' + result.inserted)
console.log('skipped:       ' + result.skipped)
console.log('errors:        ' + result.errors.length)
for (const error of result.errors.slice(0, 10)) console.log('  ! ' + error)
console.log('elapsed:       ' + elapsed + ' ms')

const totals = db.prepare(`
  SELECT COUNT(*) AS calls,
         SUM(input_tokens) AS input,
         SUM(output_tokens) AS output,
         SUM(cache_read_tokens) AS cache_read,
         CAST(SUM(CAST(total_cost_usd AS REAL)) AS TEXT) AS cost
    FROM proxy_request_logs WHERE app_type = 'dsh'
`).get()
console.log('---')
console.log('rows now in app_type=dsh: ' + JSON.stringify(totals))

const byModel = db.prepare(`
  SELECT model, COUNT(*) AS calls, MAX(pricing_model) AS pricing_model
    FROM proxy_request_logs WHERE app_type = 'dsh'
   GROUP BY model ORDER BY calls DESC
`).all()
console.log('---')
for (const row of byModel) console.log('  ' + row.model + '  calls=' + row.calls + '  pricing_model=' + (row.pricing_model ?? '(null)'))

db.close()
console.log('---')
console.log('dry run complete; the real database was never touched.')
