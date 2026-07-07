/**
 * Job Handler: ingest_workspace_statement
 *
 * The standalone P&L tool's twin of `ingest_bank_statement`. Ingests ONE file
 * (CSV / PDF / ZIP) into `pnl_workspace_transactions` for a workspace. Enqueued
 * one-per-file by `saveAndEnqueueWorkspaceUpload`.
 *
 * WHY a separate handler (not a workspace_id branch on ingest_bank_statement):
 * the tax wizard depends on that handler — this parallel handler keeps the
 * wizard's ingestion path completely untouched (the wizard-safety principle).
 *
 * Retry semantics mirror the bank handler: a transient download/enqueue problem
 * is THROWN (worker retries); an unreadable file / missing workspace returns
 * ok:false (retrying won't help).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Job, JobResult } from "../queue"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

interface IngestWorkspacePayload {
  workspace_id: string
  /** Storage path in the onboarding-uploads bucket (pnl-workspaces/{id}/…). */
  path: string
  /** Fallback bank label; the parser re-detects the real bank from content. */
  bank_label?: string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleIngestWorkspaceStatement(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as IngestWorkspacePayload
  const result: JobResult = { steps: [] }

  if (!p.workspace_id || !p.path) {
    result.steps.push(step("validate", "error", "Missing workspace_id or path"))
    result.ok = false
    result.summary = "Invalid ingest_workspace_statement payload"
    return result
  }

  const fileName = p.path.split("/").pop() ?? "statement"

  // Download — a failure may be transient → THROW so the worker retries.
  const { data: blob, error: dlErr } = await supabaseAdmin.storage
    .from("onboarding-uploads")
    .download(p.path)
  if (dlErr || !blob) throw new Error(`Download failed for ${fileName}: ${dlErr?.message ?? "no data"}`)
  const buffer = Buffer.from(await blob.arrayBuffer())

  // A .zip is a year of monthly statements — expand it (cheap, no AI) and enqueue
  // ONE workspace job per inner file, so each stays inside the worker's window.
  if (p.path.toLowerCase().endsWith(".zip")) {
    const { extractZipStatements } = await import("@/lib/bank-statement-parser")
    const { saveAndEnqueueWorkspaceUpload } = await import("@/lib/tax/workspace-upload-enqueue")
    let inner: Awaited<ReturnType<typeof extractZipStatements>>
    try {
      inner = await extractZipStatements(buffer)
    } catch (e) {
      result.steps.push(step("expand_zip", "error", `${fileName}: could not open archive — ${e instanceof Error ? e.message : String(e)}`))
      result.ok = false
      result.summary = `Could not open ${fileName}`
      return result
    }
    if (inner.length === 0) {
      result.steps.push(step("expand_zip", "error", `${fileName}: no PDF/CSV statements found inside the archive`))
      result.ok = false
      result.summary = `No statements found in ${fileName}`
      return result
    }
    let enqueued = 0, skipped = 0
    const failures: string[] = []
    for (const entry of inner) {
      try {
        const r = await saveAndEnqueueWorkspaceUpload({
          workspaceId: p.workspace_id,
          bankLabel: p.bank_label || "Bank",
          buffer: Buffer.from(entry.bytes),
          fileName: entry.name,
        })
        if (r.queued) enqueued++
        else if (r.alreadyQueued) skipped++
      } catch (e) {
        failures.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (enqueued === 0 && skipped === 0 && failures.length > 0) {
      throw new Error(`Failed to expand ${fileName}: ${failures.join("; ")}`)
    }
    result.steps.push(step("expand_zip", "ok",
      `${fileName}: expanded into ${inner.length} statement(s) — ${enqueued} queued, ${skipped} already queued${failures.length ? `, ${failures.length} failed` : ""}`))
    result.summary = `Expanded ${fileName} into ${enqueued + skipped} statement job(s)`
    return result
  }

  // Resolve the workspace context at RUN time (fresh member roster + entity).
  const { data: ws } = await db
    .from("pnl_workspaces")
    .select("tax_year, company_name, linked_account_id")
    .eq("id", p.workspace_id)
    .maybeSingle()
  if (!ws) {
    // A deleted workspace won't come back on retry — surface, don't throw.
    result.steps.push(step("resolve_workspace", "error", `workspace ${p.workspace_id} not found`))
    result.ok = false
    result.summary = "Workspace not found"
    return result
  }
  const { data: memberRows } = await db
    .from("pnl_workspace_members")
    .select("display_name")
    .eq("workspace_id", p.workspace_id)
  const memberNames = ((memberRows ?? []) as Array<{ display_name: string | null }>)
    .map(m => (m.display_name ?? "").trim())
    .filter(n => n.length > 0)

  const { ingestWorkspaceCsv } = await import("@/lib/tax/workspace-ingest")
  const r = await ingestWorkspaceCsv({
    workspaceId: p.workspace_id,
    taxYear: ws.tax_year as number,
    bankLabel: p.bank_label || "Bank",
    buffer,
    fileName,
    linkedAccountId: (ws.linked_account_id as string | null) ?? null,
    companyName: (ws.company_name as string | null) ?? "",
    memberNames,
  })

  if (r.ok) {
    result.steps.push(step("ingest", "ok",
      `${fileName}: ${r.inserted} inserted / ${r.parsed} parsed (${r.bankDetected}, ${r.months.join(", ") || "no months"})`))
    result.summary = `Ingested ${fileName}: ${r.inserted} transactions`
  } else if (r.quarantine) {
    // S1: quarantined = awaiting the one-tap staff format confirmation. The
    // step detail carries the quarantine JSON (marker-prefixed) so the
    // workspace GET can render the confirm card without extra queries.
    result.steps.push(step("ingest", "error", `FORMAT_CONFIRMATION_NEEDED:${JSON.stringify({ file: fileName, path: p.path, ...r.quarantine })}`))
    result.ok = false
    result.summary = `Needs format confirmation: ${fileName}`
  } else {
    result.steps.push(step("ingest", "error", `${fileName}: ${r.error ?? "could not read file"}`))
    result.ok = false
    result.summary = `Could not read ${fileName}`
  }
  return result
}
