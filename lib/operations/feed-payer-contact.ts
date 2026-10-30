/**
 * The database side of "invoice someone who is not a client and not a lead" (Antonio, 2026-10-30): turn the
 * payer of a bank payment into a plain person record so an invoice can belong to someone.
 *
 * A plain contact — no company, no portal access, no tier, no emails sent. A contact insert fires nothing on
 * its own (the table's only trigger stamps `updated_at` on UPDATE).
 *
 * THREE THINGS THIS GETS RIGHT, each found by a reviewer before it was built:
 *  1. NO DUPLICATE PEOPLE. A person whose email already exists, or whose name has the same words in any
 *     order ("Fattor Simone" = "Simone Fattor"), is NOT created again and NOT silently reused: the caller is
 *     told who it is (409) so staff pick them from the search. Reusing a real client without saying so would
 *     put a paid invoice in that client's portal unannounced.
 *  2. A DOUBLE CLICK CANNOT MAKE TWO PEOPLE. The new record's id is DERIVED from the payment's id, so two
 *     requests for the same payment collide on the primary key instead of both inserting. The one that
 *     inserted carries on; the other is told it is already being created.
 *  3. A RETRY AFTER A FAILURE REUSES ITS OWN LEFTOVER, found by that same derived id — never a second person.
 *
 * Writes to `contacts` must live in lib/operations/ (ESLint rule P2.4), so this is where it is.
 */
import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findContactIdByEmail } from "@/lib/operations/find-contact-by-email"
import { escapeLikePattern } from "@/lib/finance/payer-suggestions"
import { validateNewPerson, type NewPerson } from "@/lib/finance/new-person"

/** A record younger than this that we did not just insert is another request still working on it. */
export const IN_PROGRESS_WINDOW_MS = 90_000

export type FeedPayerContactResult =
  | { ok: true; contactId: string; created: boolean; fullName: string }
  /** Someone with this email or name already exists: pick them instead. */
  | { ok: false; kind: "exists"; error: string; existing: { id: string; name: string; email: string | null } }
  /** Another request for this same payment is creating the person right now. */
  | { ok: false; kind: "in_progress"; error: string }
  | { ok: false; kind: "invalid" | "failed"; error: string }

/** The id the new person for this payment will have — the same every time, for the same payment. */
export function payerContactIdForFeed(feedId: string): string {
  const h = createHash("sha1").update(`feed-payer-contact:${feedId.toLowerCase()}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50 // version 5
  h[8] = (h[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** The words of a name, lower-cased and sorted: the same person however the bank ordered the words. */
export function nameKey(fullName: string): string {
  return fullName.toLowerCase().replace(/[^a-z0-9À-ɏ\s'-]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ")
}

async function findSamePersonByName(fullName: string, exceptId: string): Promise<{ id: string; name: string; email: string | null } | null> {
  const words = nameKey(fullName).split(" ").filter((w) => w.length >= 2).slice(0, 4)
  if (words.length === 0) return null
  let q = supabaseAdmin.from("contacts").select("id, full_name, email").is("merged_into", null)
  for (const w of words) q = q.ilike("full_name", `%${escapeLikePattern(w)}%`)
  const { data } = await q.limit(15)
  const key = nameKey(fullName)
  const hit = ((data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).find((c) => c.id !== exceptId && nameKey(c.full_name ?? "") === key)
  return hit ? { id: hit.id, name: hit.full_name ?? fullName, email: hit.email } : null
}

/**
 * Find or create the person for a payment. `created` is true ONLY for a record this call inserted — the
 * caller undoes exactly that one if the invoice then cannot be made.
 */
export async function findOrCreatePayerContact(input: unknown, feedId: string): Promise<FeedPayerContactResult> {
  const checked = validateNewPerson(input)
  if (checked.ok === false) return { ok: false, kind: "invalid", error: checked.error }
  const person: NewPerson = checked.value
  const ownId = payerContactIdForFeed(feedId)

  // Our own record from an earlier attempt at this same payment (a retry after a failure)?
  const { data: own } = await supabaseAdmin.from("contacts").select("id, full_name, created_at").eq("id", ownId).maybeSingle()
  if (own) {
    const age = Date.now() - Date.parse((own as { created_at: string }).created_at)
    if (Number.isFinite(age) && age < IN_PROGRESS_WINDOW_MS) {
      return { ok: false, kind: "in_progress", error: "This person is already being created for this payment. Wait a moment and refresh." }
    }
    return { ok: true, contactId: ownId, created: false, fullName: (own as { full_name: string }).full_name }
  }

  if (person.email) {
    const existingId = await findContactIdByEmail(person.email)
    if (existingId) {
      const { data } = await supabaseAdmin.from("contacts").select("full_name, email").eq("id", existingId).maybeSingle()
      const name = (data as { full_name: string | null } | null)?.full_name ?? person.email
      return { ok: false, kind: "exists", error: `${name} is already in the CRM with that email. Search for them and pick them instead.`, existing: { id: existingId, name, email: (data as { email: string | null } | null)?.email ?? person.email } }
    }
  }
  const sameName = await findSamePersonByName(person.full_name, ownId)
  if (sameName) {
    return { ok: false, kind: "exists", error: `${sameName.name} is already in the CRM. Search for them and pick them instead.`, existing: sameName }
  }

  const today = new Date().toISOString().slice(0, 10)
  // eslint-disable-next-line no-restricted-syntax -- lib/operations is the allowed home for a contacts insert (P2.4 rule 1)
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .insert({
      id: ownId,
      full_name: person.full_name,
      first_name: person.first_name,
      last_name: person.last_name,
      email: person.email,
      notes: `Created ${today} from Bank Feed payment ${feedId.replace(/-/g, "").slice(0, 8)} — someone who paid us and is not a client or a lead.`,
    })
    .select("id, full_name")
    .single()

  if (error?.code === "23505") {
    // Another request for this same payment inserted it between our check and our insert.
    return { ok: false, kind: "in_progress", error: "This person is already being created for this payment. Wait a moment and refresh." }
  }
  if (error || !data) return { ok: false, kind: "failed", error: `Could not create the person: ${error?.message ?? "no row returned"}` }
  return { ok: true, contactId: data.id, created: true, fullName: data.full_name }
}

/**
 * Undo a person this request just created, after the invoice could not be made. Best effort and silent on
 * failure: the database refuses to delete a contact something already points to, which is exactly the
 * protection wanted — a record that gained a reference is a record someone is now using.
 */
export async function removeJustCreatedPayerContact(contactId: string): Promise<boolean> {
  // eslint-disable-next-line no-restricted-syntax -- same allowed home (P2.4 rule 1): undoing this module's own insert
  const { error } = await supabaseAdmin.from("contacts").delete().eq("id", contactId)
  return !error
}
