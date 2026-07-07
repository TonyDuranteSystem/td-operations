/**
 * Error auto-audit system — capture, dedup, and AI diagnosis of runtime errors.
 *
 * Origin: the 2026-07-07 offer-dialog incident where an expired session
 * surfaced as a bare "Unknown error" toast with zero trace anywhere. Every
 * captured error gets one row in `system_errors` keyed by a normalized
 * fingerprint; repeats bump `occurrence_count` instead of inserting new rows
 * (the audit-health-check cron's duplicate-task spam is the anti-pattern).
 * The error-audit cron then writes a plain-English `diagnosis` +
 * `suggested_fix` via the shared AI provider, surfaced on /system-health.
 *
 * Pure helpers (normalize, fingerprint, clamp) are unit-tested; DB-touching
 * functions are thin wrappers over supabaseAdmin, same split as
 * lib/system-health/queries.ts.
 *
 * Server-only: imports node:crypto and supabase-admin. Never import from a
 * client component — client code reports via POST /api/system-errors/report.
 */

import { createHash } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callAI } from "@/lib/portal/ai-provider"

// system_errors is not in the generated Database types yet (types are
// regenerated from production after the prod DDL). Same escape hatch as
// lib/td-communication/client-landing-queries.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type SystemErrorSource = "client" | "server"
export type SystemErrorStatus = "open" | "diagnosed" | "resolved" | "ignored"

export interface SystemErrorInput {
  source: SystemErrorSource
  route: string
  method?: string | null
  http_status?: number | null
  page_path?: string | null
  user_email?: string | null
  message: string
  body_snippet?: string | null
  context?: Record<string, unknown> | null
}

export interface SystemErrorRow extends SystemErrorInput {
  id: string
  fingerprint: string
  occurrence_count: number
  first_seen: string
  last_seen: string
  status: SystemErrorStatus
  diagnosis: string | null
  suggested_fix: string | null
  diagnosed_at: string | null
}

// ── Pure helpers (unit-tested) ──

/**
 * Normalize an error message so the same failure always produces the same
 * fingerprint: UUIDs, long hex strings, numbers, emails, and quoted values
 * vary per occurrence but describe one defect.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[0-9a-f]{16,}/g, "<hex>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/\d{3,}/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

/** Stable dedup key for one distinct failure mode. */
export function computeErrorFingerprint(input: Pick<SystemErrorInput, "source" | "route" | "http_status" | "message">): string {
  const raw = [
    input.source,
    input.route,
    input.http_status ?? "none",
    normalizeErrorMessage(input.message),
  ].join("|")
  return createHash("sha256").update(raw).digest("hex").slice(0, 32)
}

/** Cap free-text fields so a hostile/buggy caller can't bloat the table. */
export function clampErrorInput(input: SystemErrorInput): SystemErrorInput {
  return {
    ...input,
    route: input.route.slice(0, 300),
    method: input.method?.slice(0, 10) ?? null,
    page_path: input.page_path?.slice(0, 300) ?? null,
    user_email: input.user_email?.slice(0, 200) ?? null,
    message: input.message.slice(0, 1000),
    body_snippet: input.body_snippet?.slice(0, 2000) ?? null,
    context:
      input.context && JSON.stringify(input.context).length <= 4000
        ? input.context
        : input.context
          ? { truncated: true }
          : null,
  }
}

// ── DB wrappers ──

/**
 * Record one error occurrence. Upserts by fingerprint: first occurrence
 * inserts, repeats increment occurrence_count + refresh last_seen. A repeat of
 * a resolved/ignored error REOPENS it with diagnosis cleared, so the cron
 * re-diagnoses with fresh context. Never throws — capture must not break the
 * caller that is already handling an error.
 */
export async function reportSystemError(rawInput: SystemErrorInput): Promise<{ fingerprint: string } | null> {
  try {
    const input = clampErrorInput(rawInput)
    const fingerprint = computeErrorFingerprint(input)

    const { data: existing } = await db
      .from("system_errors")
      .select("id, occurrence_count, status")
      .eq("fingerprint", fingerprint)
      .maybeSingle()

    if (existing) {
      const reopen = existing.status === "resolved" || existing.status === "ignored"
      await db
        .from("system_errors")
        .update({
          occurrence_count: existing.occurrence_count + 1,
          last_seen: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          // Latest occurrence wins for volatile fields — helps diagnosis.
          user_email: input.user_email,
          page_path: input.page_path,
          body_snippet: input.body_snippet,
          context: input.context,
          ...(reopen
            ? { status: "open", diagnosis: null, suggested_fix: null, diagnosed_at: null }
            : {}),
        })
        .eq("id", existing.id)
    } else {
      await db.from("system_errors").insert({ ...input, fingerprint })
    }
    return { fingerprint }
  } catch (err) {
    console.error("[system-errors] capture failed (non-fatal):", err instanceof Error ? err.message : err)
    return null
  }
}

export async function listSystemErrors(opts?: { statuses?: SystemErrorStatus[]; limit?: number }): Promise<SystemErrorRow[]> {
  const { data } = await db
    .from("system_errors")
    .select("*")
    .in("status", opts?.statuses ?? ["open", "diagnosed"])
    .order("last_seen", { ascending: false })
    .limit(opts?.limit ?? 30)
  return (data ?? []) as SystemErrorRow[]
}

export async function updateSystemErrorStatus(id: string, status: SystemErrorStatus): Promise<boolean> {
  const { error } = await db
    .from("system_errors")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
  return !error
}

// ── AI diagnosis ──

export function buildDiagnosisPrompt(row: SystemErrorRow): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are the incident auditor for TD Operations, a Next.js 14 + Supabase CRM/portal for a tax & business consulting firm, hosted on Vercel.
Given one captured runtime error, explain it for the business owner (NOT an engineer) and suggest the fix.

Known failure classes in this system:
- 401 + code SESSION_EXPIRED: the user's login session expired or was rotated by another device. Solution: log in again; no data loss.
- 405/redirect + HTML body on an /api/ call: legacy symptom of an expired session before the middleware returned proper 401 JSON.
- 502 from AI endpoints: the AI provider (Anthropic) timed out or is misconfigured (ANTHROPIC_API_KEY).
- 504 / FUNCTION_INVOCATION_TIMEOUT: a Vercel function exceeded its time limit.
- 409 on offers/invoices: duplicate-protection fired; usually the action already succeeded earlier.
- RLS / permission errors: the server used the wrong Supabase client for the operation.

Respond with STRICT JSON only, no markdown fences:
{"diagnosis": "<2-3 plain-English sentences: what happened and why>", "suggested_fix": "<1-3 plain-English sentences: what the user should do now, and what the engineering fix is if code is at fault>"}`

  const userPrompt = `ERROR CAPTURE:
source: ${row.source}
route: ${row.method ?? "?"} ${row.route}
http_status: ${row.http_status ?? "n/a"}
page: ${row.page_path ?? "n/a"}
user: ${row.user_email ?? "n/a"}
occurrences: ${row.occurrence_count} (first ${row.first_seen}, last ${row.last_seen})
message: ${row.message}
response body snippet: ${row.body_snippet ?? "n/a"}
extra context: ${row.context ? JSON.stringify(row.context) : "n/a"}`

  return { systemPrompt, userPrompt }
}

/** Parse the model's JSON reply; null on any shape mismatch. */
export function parseDiagnosisReply(rawText: string): { diagnosis: string; suggested_fix: string } | null {
  try {
    const jsonStr = rawText.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    if (typeof parsed.diagnosis === "string" && typeof parsed.suggested_fix === "string") {
      return { diagnosis: parsed.diagnosis.slice(0, 2000), suggested_fix: parsed.suggested_fix.slice(0, 2000) }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Diagnose one open error row and persist the result. Returns true when a
 * diagnosis was written. Failures leave the row open for the next cron pass.
 */
export async function diagnoseSystemError(row: SystemErrorRow): Promise<boolean> {
  try {
    const { systemPrompt, userPrompt } = buildDiagnosisPrompt(row)
    const ai = await callAI({ systemPrompt, userPrompt, maxTokens: 1000, temperature: 0, model: "sonnet", timeoutMs: 30_000 })
    const parsed = parseDiagnosisReply(ai.text)
    if (!parsed) {
      console.error("[system-errors] diagnosis reply not parseable for", row.fingerprint)
      return false
    }
    const { error } = await db
      .from("system_errors")
      .update({
        diagnosis: parsed.diagnosis,
        suggested_fix: parsed.suggested_fix,
        diagnosed_at: new Date().toISOString(),
        status: "diagnosed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "open") // TOCTOU guard: don't overwrite a row someone resolved meanwhile
    return !error
  } catch (err) {
    console.error("[system-errors] diagnosis failed (non-fatal):", err instanceof Error ? err.message : err)
    return false
  }
}
