/**
 * Standalone P&L workspace upload — SAVE + ENQUEUE (async ingestion).
 *
 * The workspace twin of `saveAndEnqueueStatementUpload`: archives the raw file
 * to a WORKSPACE-scoped storage path and enqueues one `ingest_workspace_statement`
 * job. Keeps the request light (a large PDF's AI extraction runs in the worker,
 * never in-request). ISOLATION: the file lives under `pnl-workspaces/{id}/…`,
 * never a client's `tax/{account}/…` folder (sealed leak #5); the job is tagged
 * `related_entity_type='pnl_workspace'` and carries no account_id.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { sha256Hex } from "./statement-uploads"

export interface SaveAndEnqueueWorkspaceInput {
  workspaceId: string
  /** Free-text bank name — fallback identity only; parser re-detects. */
  bankLabel: string
  buffer: Buffer
  fileName: string
}

export interface SaveAndEnqueueWorkspaceResult {
  queued: boolean
  alreadyQueued: boolean
  path: string
}

export async function saveAndEnqueueWorkspaceUpload(
  input: SaveAndEnqueueWorkspaceInput,
): Promise<SaveAndEnqueueWorkspaceResult> {
  const { workspaceId, bankLabel, buffer, fileName } = input

  const sha = sha256Hex(buffer)
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  // Content-hashed + workspace-namespaced path (never a client's tax folder).
  const path = `pnl-workspaces/${workspaceId}/${sha.slice(0, 16)}_${safeName}`

  const contentType = /\.pdf$/i.test(fileName)
    ? "application/pdf"
    : /\.zip$/i.test(fileName)
      ? "application/zip"
      : "text/csv"

  // 1. Archive the raw file (upsert → identical file lands on the same object).
  const { error: upErr } = await supabaseAdmin.storage
    .from("onboarding-uploads")
    .upload(path, buffer, { contentType, upsert: true })
  if (upErr) throw new Error(`Could not save the file: ${upErr.message}`)

  // 2. Idempotency: skip if this exact path already has a non-failed job.
  const { data: existing } = await supabaseAdmin
    .from("job_queue")
    .select("id")
    .eq("job_type", "ingest_workspace_statement")
    .eq("payload->>path", path)
    .neq("status", "failed")
    .limit(1)
  if (existing && existing.length > 0) {
    return { queued: false, alreadyQueued: true, path }
  }

  // 3. DIRECT insert (no triggerWorker dangle — same discipline as the portal path).
  const { error: jobErr } = await supabaseAdmin.from("job_queue").insert({
    job_type: "ingest_workspace_statement",
    payload: { workspace_id: workspaceId, path, bank_label: bankLabel },
    priority: 4,
    related_entity_type: "pnl_workspace",
    related_entity_id: workspaceId,
    created_by: "pnl_workspace_upload",
  } as never)
  if (jobErr) throw new Error(`Could not queue the file for processing: ${jobErr.message}`)

  return { queued: true, alreadyQueued: false, path }
}
