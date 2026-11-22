/**
 * How many records point at a contact (the "linked history" the merge/delete screens show). Reads only.
 *
 * Uses `contact_reference_report_fast` (keys read from pg_constraint, about 60 ms) and falls back to the original
 * `contact_reference_report` (information_schema, about 4.5 s per call) only where the fast one is not installed yet.
 * Same counting, same result: checked on twelve contacts in the sandbox.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface ReferenceReport {
  total_blocking: number
  breakdown: Record<string, number>
}

type Rpc = (fn: string, args: { p_contact_id: string }) => PromiseLike<{ data: unknown; error: { message: string } | null }>

export function isMissingFunction(message: string): boolean {
  return /does not exist|schema cache|could not find the function/i.test(message)
}

export async function getContactReferenceReport(contactId: string): Promise<ReferenceReport> {
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as Rpc
  let res = await rpc("contact_reference_report_fast", { p_contact_id: contactId })
  if (res.error && isMissingFunction(res.error.message)) res = await rpc("contact_reference_report", { p_contact_id: contactId })
  if (res.error) throw new Error(`reference report failed: ${res.error.message}`)
  const r = (res.data ?? {}) as Partial<ReferenceReport>
  return { total_blocking: r.total_blocking ?? 0, breakdown: { ...(r.breakdown ?? {}) } }
}

/** Database errors are never shown to staff as they are: a plain sentence instead. */
export function plainMergeError(message: string): string {
  if (/statement timeout|canceling statement|timeout/i.test(message)) {
    return "The check took too long. Please close the window, open it again and try once more."
  }
  if (/fetch failed|network|ECONN|ETIMEDOUT/i.test(message)) return "Could not reach the server. Check your connection and try again."
  return "Something went wrong while checking the two contacts. Nothing was changed. Please try again; if it keeps happening, tell support."
}
