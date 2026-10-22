/**
 * Calendar team notes — the server side (dev job 388bb74b). SERVER-ONLY. The table is staff-only (RLS on, no policy): only these
 * functions, behind the Calendar's own guard, read or write it.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { summariseNotes, type JobNote, type NoteSummary } from "@/lib/job-notes/types"

// The table is not in the generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

interface NoteRow { id: string; service_delivery_id: string; body: string; author_name: string; created_at: string }
const toNote = (r: NoteRow): JobNote => ({ id: r.id, body: r.body, authorName: r.author_name, createdAt: r.created_at })

const IN_CHUNK = 200

/**
 * One summary per job for the rows on screen. TOLERANT on purpose: if the table is missing (a database the migration has not reached) or the
 * read fails, the Calendar still loads — it just shows no notes (and logs). A note must never take the work list down.
 */
export async function loadNoteSummaries(jobIds: string[]): Promise<Map<string, NoteSummary>> {
  const ids = Array.from(new Set(jobIds.filter(Boolean)))
  const flat: Array<JobNote & { jobId: string }> = []
  try {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await db().from("service_delivery_notes").select("id, service_delivery_id, body, author_name, created_at").in("service_delivery_id", ids.slice(i, i + IN_CHUNK)).order("created_at", { ascending: false }).limit(5000)
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as NoteRow[]) flat.push({ ...toNote(r), jobId: r.service_delivery_id })
    }
  } catch (err) {
    console.error("[job-notes] could not read the notes — the Calendar shows none:", err instanceof Error ? err.message : String(err))
    return new Map()
  }
  return summariseNotes(flat)
}

/** The whole list of one job, newest first. Throws on a read error (the pop-up says so). */
export async function listJobNotes(jobId: string): Promise<JobNote[]> {
  const { data, error } = await db().from("service_delivery_notes").select("id, service_delivery_id, body, author_name, created_at").eq("service_delivery_id", jobId).order("created_at", { ascending: false }).limit(500)
  if (error) throw new Error(error.message)
  return ((data ?? []) as NoteRow[]).map(toNote)
}

/** Does this job exist and is it a real (not test) job? null = no such job. */
export async function jobForNotes(jobId: string): Promise<{ id: string; is_test: boolean } | null> {
  const { data, error } = await supabaseAdmin.from("service_deliveries").select("id, is_test").eq("id", jobId).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? { id: data.id as string, is_test: data.is_test === true } : null
}

export async function addJobNote(p: { jobId: string; body: string; authorUserId: string | null; authorName: string }): Promise<JobNote> {
  const { data, error } = await db().from("service_delivery_notes").insert({ service_delivery_id: p.jobId, body: p.body, author_user_id: p.authorUserId, author_name: p.authorName }).select("id, service_delivery_id, body, author_name, created_at").single()
  if (error || !data) throw new Error(error?.message ?? "no row returned")
  return toNote(data as NoteRow)
}
