/**
 * Portal-translation watchdog (dev job 12cab351, part of the same 5-minute
 * cron the AI-chain watchdog already runs on). Same pure decision brain
 * (decideChainState / AI_CHAIN_BACKOFF_MS from ./chain-state), a SEPARATE
 * module rather than extending chain-watchdog.ts directly — that file's
 * scope shape (workspace/account+year) and its confirmed-submission guard
 * are specific to bank-transaction categorization and don't apply here, and
 * it already carries real production traffic; keeping this additive avoids
 * any risk of regressing it.
 *
 * Closes a real gap found live 2026-08-23: a translate_language chunk that
 * hits halt_no_progress (dead API key, repeated bad responses) retries up to
 * the queue's own max_attempts, then sits permanently 'failed' — nothing
 * ever re-enqueues it, and nobody is told. A language can stop dead partway
 * translated with zero visibility. This gives it the same self-healing shape
 * already proven for recategorize_ai: auto-retry on a backoff ladder while
 * candidates remain, then ONE staff alert when the ladder is spent.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { decideChainState, AI_CHAIN_JOB_PRIORITY, AI_CHAIN_BACKOFF_MS } from "./chain-state"
import { getEnglishDictionary } from "@/lib/portal/i18n"
import { getWizardTranslatableText } from "@/lib/portal/wizard-translatable-text"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const SCOPE_LOOKBACK_MS = 7 * 24 * 3600_000
const SCOPE_CAP = 50
const STAFF_ALERT_EMAIL = "support@tonydurante.us"

type Source = "dictionary" | "wizard"

interface ScopeKey {
  languageCode: string
  languageName: string
  source: Source
}

interface JobRow {
  id: string
  status: string
  completed_at: string | null
  payload: { language_code?: string; language_name?: string; source?: Source; auto_retry?: number } | null
}

function scopeId(s: ScopeKey): string {
  return `translate:${s.languageCode}:${s.source}`
}

function sourceDictionaryFor(source: Source): Record<string, string> {
  return source === "wizard" ? getWizardTranslatableText() : getEnglishDictionary()
}

/**
 * Rows for ONE language, paged past Supabase's default 1000-row cap (the
 * exact cap that silently truncated an earlier count this same session —
 * see reference_vacuous_green_on_wrong_column-style traps). Filtered
 * client-side against the source's own key set rather than a PostgREST
 * `.in()` list — an already-hit bug in this codebase: a wizard-content key
 * containing a literal double-quote corrupts `.in()` matching for the WHOLE
 * list, not just itself (see translate-language.ts / translation-generator.ts
 * BUG #2 comments).
 */
async function candidatesRemaining(s: ScopeKey): Promise<number> {
  const sourceKeys = new Set(Object.keys(sourceDictionaryFor(s.source)))
  const rows: Array<{ key: string; status: string }> = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("portal_translations")
      .select("key, status")
      .eq("language_code", s.languageCode)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`candidatesRemaining read failed for ${scopeId(s)}: ${error.message}`)
    rows.push(...((data ?? []) as Array<{ key: string; status: string }>))
    if (!data || data.length < PAGE) break
  }
  return rows.filter(r => sourceKeys.has(r.key) && r.status !== "done").length
}

export interface TranslationWatchdogResult {
  scopes: number
  reEnqueued: string[]
  exhaustedAlerts: string[]
  errors: string[]
}

export async function runTranslationWatchdog(now = Date.now()): Promise<TranslationWatchdogResult> {
  const out: TranslationWatchdogResult = { scopes: 0, reEnqueued: [], exhaustedAlerts: [], errors: [] }

  const { data: jobRows, error } = await db
    .from("job_queue")
    .select("id, status, completed_at, payload")
    .eq("job_type", "translate_language")
    .gte("created_at", new Date(now - SCOPE_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) { out.errors.push(error.message); return out }

  const scopes = new Map<string, { key: ScopeKey; rows: JobRow[] }>()
  for (const j of (jobRows ?? []) as JobRow[]) {
    const languageCode = j.payload?.language_code
    const languageName = j.payload?.language_name
    const source: Source = j.payload?.source === "wizard" ? "wizard" : "dictionary"
    if (!languageCode || !languageName) continue
    const key: ScopeKey = { languageCode, languageName, source }
    const id = scopeId(key)
    if (!scopes.has(id)) {
      if (scopes.size >= SCOPE_CAP) continue
      scopes.set(id, { key, rows: [] })
    }
    scopes.get(id)!.rows.push(j)
  }
  out.scopes = scopes.size

  for (const [id, { key, rows }] of Array.from(scopes.entries())) {
    try {
      const liveJobs = rows.filter(r => r.status === "pending" || r.status === "processing").length
      const terminals = rows
        .filter(r => (r.status === "completed" || r.status === "failed") && r.completed_at)
        .sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1))
      const lastTerminal = terminals[0]
        ? { completed_at: terminals[0].completed_at, auto_retry: terminals[0].payload?.auto_retry ?? 0, jobId: terminals[0].id }
        : null
      if (liveJobs > 0 || !lastTerminal) continue // running, or never ran here — nothing to do

      const remaining = await candidatesRemaining(key)
      const state = decideChainState({
        liveJobs, candidatesRemaining: remaining,
        lastTerminal: { completed_at: lastTerminal.completed_at, auto_retry: lastTerminal.auto_retry },
        killSwitchOn: false, now,
      })

      if (state.state === "retry_scheduled" && now >= state.nextRetryAt) {
        const { data: inserted, error: insErr } = await db.from("job_queue").insert({
          job_type: "translate_language",
          payload: {
            language_code: key.languageCode,
            language_name: key.languageName,
            source: key.source,
            chunk_index: 0,
            auto_retry: lastTerminal.auto_retry + 1,
          },
          priority: AI_CHAIN_JOB_PRIORITY,
          created_by: "translation-watchdog",
        }).select("id").single()
        if (insErr) throw new Error(insErr.message)
        // Post-insert verify (same F3 guard as chain-watchdog.ts): the
        // SELECT-then-INSERT above isn't atomic — if a concurrent runner
        // (a client's own pick, the fix's own self-trigger) also inserted a
        // live job for this scope in the meantime, delete OUR row and let
        // theirs run; two live jobs for one scope is exactly the duplicate
        // this fix exists to prevent.
        const { data: live } = await db
          .from("job_queue")
          .select("id")
          .in("status", ["pending", "processing"])
          .eq("job_type", "translate_language")
          .eq("payload->>language_code", key.languageCode)
          .eq("payload->>source", key.source)
        if ((live ?? []).length > 1) {
          await db.from("job_queue").delete().eq("id", inserted.id).eq("status", "pending")
        } else {
          out.reEnqueued.push(id)
        }
      } else if (state.state === "exhausted") {
        const { data: existing } = await db
          .from("action_log")
          .select("id")
          .eq("action_type", "translation_chain_exhausted")
          .eq("record_id", lastTerminal.jobId)
          .limit(1)
        if (!existing || existing.length === 0) {
          await db.from("action_log").insert({
            actor: "translation-watchdog",
            action_type: "translation_chain_exhausted",
            table_name: "job_queue",
            record_id: lastTerminal.jobId,
            summary: `Portal translation chain exhausted ${AI_CHAIN_BACKOFF_MS.length} auto-retries — ${id}, ${remaining} entries untranslated`,
            details: { scope: id, remaining, last_terminal_job_id: lastTerminal.jobId },
          })
          try {
            const subject = `⚠️ Portal translation stuck — ${key.languageName} (${remaining} entries untranslated)`
            const html = `
              <div style="font-family:sans-serif">
                <p><strong>The portal translation job for ${key.languageName} (${key.source}) stopped after ${AI_CHAIN_BACKOFF_MS.length} automatic retries over ~24h.</strong></p>
                <p>${remaining} entries remain untranslated for this language. Likely causes: an API key/quota problem, or a persistent API outage.</p>
                <p style="color:#9ca3af;font-size:12px;">Automated staff alert — portal translation watchdog (one email per exhaustion event).</p>
              </div>`
            const { gmailPost } = await import("@/lib/gmail")
            const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
            const boundary = `boundary_${lastTerminal.jobId.slice(0, 8)}`
            const raw = [
              `From: TD Operations <support@tonydurante.us>`,
              `To: ${STAFF_ALERT_EMAIL}`,
              `Subject: ${encodedSubject}`,
              `MIME-Version: 1.0`,
              `Content-Type: multipart/alternative; boundary="${boundary}"`,
              "",
              `--${boundary}`,
              `Content-Type: text/html; charset=UTF-8`,
              `Content-Transfer-Encoding: base64`,
              "",
              Buffer.from(html).toString("base64"),
              `--${boundary}--`,
            ].join("\r\n")
            await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
          } catch (e) {
            console.error("[translation-watchdog] exhaustion email failed (action_log written):", e)
          }
          out.exhaustedAlerts.push(id)
        }
      }
    } catch (e) {
      out.errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}
