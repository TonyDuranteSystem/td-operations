/**
 * Booking page, "People" (Antonio, 14 Nov 2026): a person who is JUST A CONTACT — no lead, no company, nothing sold. The link is made for them and the call they
 * book is saved under their contact (contact_calls), like an entry in an address book.
 *
 * This is the database side of making that contact when the link is made. A plain contact record: name, first and last name, email, a one-line note. No company, no
 * portal tier, no emails sent, no lead. (A contact insert fires nothing on its own — the table's only trigger stamps `updated_at` on UPDATE.)
 *
 * FIND BEFORE CREATE, alias-aware: the same email lookup the webhook uses (email, second email, alternate emails; merged tombstones ignored). A person who is
 * already a contact is REUSED, never duplicated — and the preview says so before the link is made. Two staff making the same link at the same moment could still
 * both miss each other; the second insert then runs into the email check below and reuses the first, or (rarely) leaves two records that the contact merge tool joins.
 *
 * Writes to `contacts` must live in lib/operations/ (ESLint rule P2.4), so this is where it is. The client is passed in (service client, or a fake in a test).
 */

import { findContactByAnyEmail } from "@/lib/operations/contact-email-aliases"
import { validateNewPerson } from "@/lib/finance/new-person"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

export type BookingContactResult =
  | { ok: true; contactId: string; /** true ONLY for a record this call inserted (the caller can undo exactly that one) */ created: boolean; fullName: string }
  | { ok: false; error: string }

const READ_FAILED = "The contacts could not be read. Try again."

/** Name and email as typed on the page, checked: both are needed (the email is how the booking is matched to the contact). Plain words on a refusal. */
export function checkPeopleInput(name: unknown, email: unknown): { ok: true; fullName: string; firstName: string; lastName: string | null; email: string } | { ok: false; error: string } {
  const v = validateNewPerson({ full_name: name, email })
  if (v.ok === false) return { ok: false, error: v.error }
  if (!v.value.email) return { ok: false, error: "Write the person's email: it is how their booking is matched to them." }
  return { ok: true, fullName: v.value.full_name, firstName: v.value.first_name, lastName: v.value.last_name, email: v.value.email }
}

/** Today's date in New York, for the note on the new contact. */
function todayNy(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" })
}

export async function findOrCreateBookingContact(db: Db, input: { name: unknown; email: unknown }, now: Date = new Date()): Promise<BookingContactResult> {
  const p = checkPeopleInput(input.name, input.email)
  if (p.ok === false) return { ok: false, error: p.error }

  const first = await findContactByAnyEmail(db, p.email)
  if (first.state === "error") return { ok: false, error: READ_FAILED }
  if (first.state === "found") return { ok: true, contactId: first.contact.id, created: false, fullName: first.contact.full_name ?? p.fullName }

  try {
    // eslint-disable-next-line no-restricted-syntax -- lib/operations is the allowed home for a contacts insert (P2.4 rule 1)
    const { data, error } = await db
      .from("contacts")
      .insert({
        full_name: p.fullName,
        first_name: p.firstName,
        last_name: p.lastName,
        email: p.email,
        notes: `Created ${todayNy(now)} from the Booking page (a People link): just a contact, no lead and no company.`,
      })
      .select("id, full_name")
      .single()
    if (error?.code === "23505") {
      // someone made the same contact between our look and our insert: use theirs
      const again = await findContactByAnyEmail(db, p.email)
      if (again.state === "found") return { ok: true, contactId: again.contact.id, created: false, fullName: again.contact.full_name ?? p.fullName }
      return { ok: false, error: "The contact could not be saved. Try again." }
    }
    if (error || !data) return { ok: false, error: "The contact could not be saved. Try again." }
    const mine = data.id as string
    // The table has no unique rule on email, so two requests at the same instant can both insert. Look once more: the OLDEST record wins, and a newer one of ours is removed.
    const after = await findContactByAnyEmail(db, p.email)
    if (after.state === "found" && after.contact.id !== mine) {
      await removeJustCreatedBookingContact(db, mine)
      return { ok: true, contactId: after.contact.id, created: false, fullName: after.contact.full_name ?? p.fullName }
    }
    return { ok: true, contactId: mine, created: true, fullName: (data.full_name as string | null) ?? p.fullName }
  } catch {
    return { ok: false, error: "The contact could not be saved. Try again." }
  }
}

/**
 * Undo the contact THIS request just made, when the link could not be saved after it. Best effort and silent on failure: the database refuses to delete a contact
 * something already points to, which is exactly the protection wanted — a record that gained a reference is a record someone now uses.
 */
export async function removeJustCreatedBookingContact(db: Db, contactId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- same allowed home (P2.4 rule 1): undoing this module's own insert
    const { error } = await db.from("contacts").delete().eq("id", contactId)
    return !error
  } catch {
    return false
  }
}
