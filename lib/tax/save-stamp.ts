/**
 * ONE time on the saved PDF per client submit (dev job 7df278cd, Shipment 2).
 *
 * The questionnaire PDF prints "Submitted: <time>". Two writers file that PDF after a submit — the setup job's own inline copy and the
 * durable save job — and each used its own clock, so one submit left two versions of the same file, differing only in that time
 * (found live: a resubmit made version 4 AND version 5). The "earlier copies" card would then have shown noise after nearly every
 * approval. Both writers now take the time from here: it is pinned in the submission's `drive_archive_meta.stamp` next to the
 * fingerprint of the answers it belongs to. The same answers → the same time → the same bytes → the store answers "unchanged".
 * CHANGED answers get a fresh time (a real new version).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { mergeArchiveMeta } from "@/lib/archive/meta-merge"
import { answersFingerprint, sameSubmittedAnswers } from "@/lib/tax/answers-fingerprint"
import { readSaveMeta } from "@/lib/tax/save-state"

export interface SubmitStamp {
  /** fingerprint of the answers + files this time belongs to */
  fp: string
  at: string
}

/** Pure: the time already pinned for THESE answers, or a new one. */
export function pickStamp(meta: unknown, fp: string, nowIso: string): { stamp: SubmitStamp; isNew: boolean } {
  const pinned = readSaveMeta(meta).stamp
  if (pinned && pinned.fp === fp) return { stamp: pinned, isNew: false }
  return { stamp: { fp, at: nowIso }, isNew: true }
}

export interface StampRow {
  submitted_data: unknown
  upload_paths: unknown
  drive_archive_meta: unknown
}

/**
 * The time to print on this submission's PDF. Reads the row unless the caller already has it. A new time is stored before it is used,
 * so the other writer finds it. If two writers pin at the same instant the stored one wins and both use it. Throws on a database
 * error: the caller decides (the setup job falls back to its own clock, the save job retries).
 */
export async function pinnedSubmitStamp(submissionId: string, row?: StampRow, now: Date = new Date()): Promise<SubmitStamp> {
  let r = row
  if (!r) {
    const { data, error } = await supabaseAdmin.from("tax_return_submissions").select("submitted_data, upload_paths, drive_archive_meta").eq("id", submissionId).maybeSingle()
    if (error) throw new Error(`stamp: submission read failed: ${error.message}`)
    if (!data) throw new Error("stamp: submission not found")
    r = data as unknown as StampRow
  }
  const paths = Array.isArray(r.upload_paths) ? (r.upload_paths as unknown[]).filter((p): p is string => typeof p === "string") : []
  const fp = answersFingerprint(r.submitted_data, paths)
  const picked = pickStamp(r.drive_archive_meta, fp, now.toISOString())
  if (!picked.isNew) return picked.stamp

  await mergeArchiveMeta("tax_return_submissions", submissionId, { stamp: picked.stamp })
  const { data: again } = await supabaseAdmin.from("tax_return_submissions").select("drive_archive_meta").eq("id", submissionId).maybeSingle()
  const stored = readSaveMeta((again as { drive_archive_meta?: unknown } | null)?.drive_archive_meta).stamp
  return stored && stored.fp === fp ? stored : picked.stamp
}

/**
 * A background job started from one submit carries its OWN copy of the answers. If the client has resubmitted since, the record holds
 * newer answers and that copy is out of date: filing it would print the old answers under the new answers' pinned time (and the
 * resubmit's own job files the new ones anyway). True only when the record was read and differs; an unreadable record is NOT "stale"
 * (the caller then does what it always did).
 */
export async function payloadIsStale(submissionId: string, payloadData: unknown, payloadUploadPaths: unknown): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("tax_return_submissions").select("submitted_data, upload_paths").eq("id", submissionId).maybeSingle()
  if (error || !data) return false
  const row = data as unknown as { submitted_data: unknown; upload_paths: unknown }
  return !sameSubmittedAnswers(payloadData, payloadUploadPaths, row.submitted_data, row.upload_paths)
}
