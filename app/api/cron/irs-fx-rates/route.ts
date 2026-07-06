/**
 * GET /api/cron/irs-fx-rates — automatic IRS yearly-average FX rate import
 * (2026-07-06, Antonio: "I want it fully automatic").
 *
 * Monthly (vercel.json: 2nd of month, 07:00 UTC — the IRS refreshes the table
 * once a year, early in the year; monthly polling picks the new year up within
 * a month of publication at negligible cost, and every run is idempotent).
 *
 * Pipeline: fetch irs.gov page → parseIrsRatesHtml (pure, FAIL-CLOSED — any
 * structural surprise throws and NOTHING is written) → decideFxImport
 * (INSERT-ONLY — an existing (year, currency) row is never overwritten; a
 * mismatch with the page is a human-review alert, because a stored rate may
 * already back a filed return) → insert + action_log + alert email.
 *
 * Alerts (support@, RFC 2047 subject per R041): parse/fetch failure, value
 * diffs, unmapped currencies (IRS added a country the ISO map doesn't know).
 * New-year rates arriving is NORMAL and logged, not alerted.
 * Sandbox: gmail.ts blocks outbound mail in SANDBOX_MODE — alerts are prod-only
 * by construction; DB writes still exercise the full path in sandbox.
 *
 * Auth: CRON_SECRET Bearer token (house pattern).
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { IRS_FX_URL, IRS_CURRENCY_ISO, parseIrsRatesHtml, decideFxImport } from "@/lib/tax/irs-fx-import"

const ENDPOINT = "/api/cron/irs-fx-rates"
const ALERT_TO = "support@tonydurante.us"
const FROM_HEADER = "Tony Durante CRM <support@tonydurante.us>"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function sendAlert(subject: string, html: string): Promise<void> {
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=` // R041
    const mime = [
      `From: ${FROM_HEADER}`,
      `To: ${ALERT_TO}`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
    ].join("\r\n")
    await gmailPost("/messages/send", { raw: Buffer.from(mime).toString("base64url") })
  } catch (e) {
    console.error("[irs-fx-rates] alert email failed (import result unaffected):", e)
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const res = await fetch(IRS_FX_URL, { headers: { "user-agent": "td-operations-fx-import/1.0" } })
    if (!res.ok) throw new Error(`irs.gov responded ${res.status}`)
    const html = await res.text()

    const parsed = parseIrsRatesHtml(html) // throws fail-closed

    const { data: existing, error: readErr } = await db
      .from("irs_exchange_rates")
      .select("tax_year, currency, rate_to_usd")
    if (readErr) throw new Error(`rates read failed: ${readErr.message}`)

    const { inserts, diffs } = decideFxImport(parsed.rates, existing ?? [])

    let inserted = 0
    const insertFailures: Array<{ tax_year: number; currency: string; error: string }> = []
    if (inserts.length > 0) {
      const rows = inserts.map(r => ({ ...r, source_url: IRS_FX_URL, fetched_at: new Date().toISOString() }))
      const { error: insErr } = await db.from("irs_exchange_rates").insert(rows)
      if (!insErr) {
        inserted = inserts.length
      } else {
        // One unstorable rate must never block the others (real case: prod's
        // rate_to_usd was numeric(10,6) — Venezuela/Lebanon overflow it until
        // the column-widening DDL runs). Fall back to per-row inserts and
        // report the stragglers instead of failing the whole run.
        for (const row of rows) {
          const { error: rowErr } = await db.from("irs_exchange_rates").insert(row)
          if (rowErr) insertFailures.push({ tax_year: row.tax_year, currency: row.currency, error: rowErr.message })
          else inserted++
        }
      }
      try {
        await db.from("action_log").insert({
          actor: "system:irs-fx-import",
          action_type: "irs_fx_rates_imported",
          table_name: "irs_exchange_rates",
          summary: `Imported ${inserted} IRS yearly-average rate(s): ${Array.from(new Set(inserts.map(i => i.tax_year))).sort().join(", ")}`,
          details: { years: parsed.years, inserted, sample: inserts.slice(0, 10) },
        })
      } catch (e) {
        console.error("[irs-fx-rates] action_log failed (rates saved fine):", e)
      }
    }

    if (diffs.length > 0) {
      await sendAlert(
        `IRS FX rates: ${diffs.length} stored rate(s) differ from irs.gov — review needed`,
        `<p>The monthly IRS FX import found stored rates that no longer match the official page. Nothing was overwritten — a stored rate may back a filed return. Review and correct manually if appropriate.</p><ul>${diffs.map(d => `<li>${d.currency} ${d.tax_year}: stored ${d.stored} vs page ${d.page}</li>`).join("")}</ul><p>Source: <a href="${IRS_FX_URL}">${IRS_FX_URL}</a></p>`,
      )
    }
    if (parsed.unmapped.length > 0) {
      await sendAlert(
        `IRS FX rates: ${parsed.unmapped.length} unmapped currenc(ies) on irs.gov`,
        `<p>The IRS page lists currencies the importer's ISO map doesn't know — they were skipped, not guessed. Add them to IRS_CURRENCY_ISO in lib/tax/irs-fx-import.ts.</p><ul>${parsed.unmapped.map(u => `<li>${u}</li>`).join("")}</ul>`,
      )
    }
    // Malformed cells (the page really prints Russia 2021 as ".73.686") are
    // skipped-not-guessed; alert ONLY when the bad cell (a) blocks a rate we
    // don't already have AND (b) is a RECENT year (the two newest columns) —
    // a historic typo the IRS never fixes must not email staff monthly; it
    // stays visible in every run's cron_log details.
    const storedKeys = new Set(((existing ?? []) as Array<{ tax_year: number; currency: string }>).map(e => `${e.tax_year}|${e.currency}`))
    const recentYears = new Set([...parsed.years].sort((a, b) => b - a).slice(0, 2))
    const blockingBadCells = parsed.badCells.filter(b => {
      if (!recentYears.has(b.tax_year)) return false
      const iso = IRS_CURRENCY_ISO[b.key]
      return iso ? !storedKeys.has(`${b.tax_year}|${iso}`) : true
    })
    if (blockingBadCells.length > 0) {
      await sendAlert(
        `IRS FX rates: ${blockingBadCells.length} unreadable cell(s) on irs.gov — rates missing`,
        `<p>These cells on the IRS page don't parse as usable rates and we have no stored value for them — skipped, not guessed. Add the correct value manually with a documented source if a return needs it.</p><ul>${blockingBadCells.map(b => `<li>${b.key} ${b.tax_year}: "${b.raw}"</li>`).join("")}</ul><p>Source: <a href="${IRS_FX_URL}">${IRS_FX_URL}</a></p>`,
      )
    }
    if (insertFailures.length > 0) {
      await sendAlert(
        `IRS FX rates: ${insertFailures.length} rate(s) could not be stored — action needed`,
        `<p>These parsed rates failed to insert (the others saved fine). Known cause: the rate_to_usd column is numeric(10,6) — run the widening line from scripts/migrations/20260706-2100-irs-exchange-rates-full-seed.sql in the Supabase dashboard (<code>ALTER TABLE irs_exchange_rates ALTER COLUMN rate_to_usd TYPE numeric;</code>) and the next run self-fills them.</p><ul>${insertFailures.map(f => `<li>${f.currency} ${f.tax_year}: ${f.error}</li>`).join("")}</ul>`,
      )
    }
    const summary = { years: parsed.years, parsed: parsed.rates.length, inserted, insert_failures: insertFailures.length, diffs: diffs.length, unmapped: parsed.unmapped.length, bad_cells: parsed.badCells.length }
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - start, details: summary })
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[irs-fx-rates] import failed (no writes):", err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    await sendAlert(
      "IRS FX rate import FAILED — no rates written",
      `<p>The monthly IRS FX import aborted fail-closed (zero writes):</p><pre>${message}</pre><p>Likely causes: irs.gov page redesign or outage. The importer is lib/tax/irs-fx-import.ts; the page is <a href="${IRS_FX_URL}">here</a>.</p>`,
    )
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
