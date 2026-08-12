/**
 * Re-process QUARANTINED portal statement files after staff confirm a format
 * (card 4a39e0fd, Antonio's ruling 2026-08-12: "a quarantined file after staff
 * confirm its format must re-process automatically — a client must never sit
 * stuck behind a file we already approved").
 *
 * When staff confirm a proposed mapping (the one-tap S1 flow), every FAILED
 * `ingest_bank_statement` job whose quarantine marker carries that mapping id
 * gets: (1) its old job(s) CANCELLED (so the per-file state stops reading
 * "quarantined"), and (2) ONE fresh ingest job enqueued with the original
 * payload — the re-parse now hits the stored, staff-confirmed mapping and
 * ingests deterministically. Idempotent: a path that already has a non-failed
 * job is skipped (the cancel still runs, so states can't stick).
 *
 * The reject path deliberately does NOT re-enqueue: the file stays failed with
 * the W9 messaging, staff request a proper export.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { FORMAT_CONFIRMATION_MARKER } from "./ingest-file-status"

export interface QuarantineRequeueResult {
  /** Fresh ingest jobs enqueued. */
  requeued: number
  /** Old quarantined jobs cancelled. */
  cancelled: number
  /** Paths skipped because a non-failed job already exists. */
  skipped: number
}

interface FailedIngestJob {
  id: string
  account_id: string | null
  payload: Record<string, unknown> | null
  result: { steps?: Array<{ detail?: string }> } | null
}

/** Parse a job's quarantine marker; null when the job carries none. */
export function quarantineMarkerOf(job: Pick<FailedIngestJob, "result">): { mapping_id?: string | null } | null {
  for (const s of job.result?.steps ?? []) {
    if (typeof s.detail === "string" && s.detail.startsWith(FORMAT_CONFIRMATION_MARKER)) {
      try {
        return JSON.parse(s.detail.slice(FORMAT_CONFIRMATION_MARKER.length)) as { mapping_id?: string | null }
      } catch {
        return {}
      }
    }
  }
  return null
}

export async function requeueQuarantinedPortalIngests(mappingId: string): Promise<QuarantineRequeueResult> {
  const out: QuarantineRequeueResult = { requeued: 0, cancelled: 0, skipped: 0 }

  // Failed portal ingest jobs are a small set (17 rows in production at the
  // time of writing) — fetch and filter by marker in JS rather than a fragile
  // JSONB-text match.
  const { data: failed } = await supabaseAdmin
    .from("job_queue")
    .select("id, account_id, payload, result")
    .eq("job_type", "ingest_bank_statement")
    .eq("status", "failed")
  const quarantined = ((failed ?? []) as FailedIngestJob[]).filter(j => {
    const marker = quarantineMarkerOf(j)
    return marker !== null && marker.mapping_id === mappingId
  })
  if (quarantined.length === 0) return out

  // One fresh job per distinct path; cancel every old row for those paths.
  const byPath = new Map<string, FailedIngestJob>()
  for (const j of quarantined) {
    const path = typeof j.payload?.path === "string" ? (j.payload.path as string) : null
    if (path && !byPath.has(path)) byPath.set(path, j)
  }

  for (const [path, j] of Array.from(byPath.entries())) {
    // Cancel old quarantined rows FIRST so the per-file state can't stay
    // "quarantined" even if the enqueue below is skipped.
    const { data: cancelledRows } = await supabaseAdmin
      .from("job_queue")
      .update({ status: "cancelled", error: `Superseded: format confirmed by staff (mapping ${mappingId})` })
      .eq("job_type", "ingest_bank_statement")
      .eq("payload->>path", path)
      .eq("status", "failed")
      .select("id")
    out.cancelled += (cancelledRows ?? []).length

    const { data: live } = await supabaseAdmin
      .from("job_queue")
      .select("id")
      .eq("job_type", "ingest_bank_statement")
      .eq("payload->>path", path)
      .not("status", "in", "(failed,cancelled)")
      .limit(1)
    if (live && live.length > 0) {
      out.skipped++
      continue
    }

    const { error } = await supabaseAdmin.from("job_queue").insert({
      job_type: "ingest_bank_statement",
      payload: j.payload as never,
      priority: 4,
      account_id: j.account_id,
      created_by: "format_confirm",
    } as never)
    if (!error) out.requeued++
    else console.error(`[quarantine-requeue] enqueue failed for ${path}: ${error.message}`)
  }

  return out
}
