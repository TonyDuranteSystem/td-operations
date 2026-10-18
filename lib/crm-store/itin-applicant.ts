/**
 * WHO is this ITIN for? Decided from the submission's own data (the person who filled the form), never from "the first
 * linked contact" — on a company with several members that guess files the documents under the wrong person
 * (Stop Drive S1b round 2, dev job 264bb882). Returns the person only when it is certain; otherwise a plain refusal.
 */

export interface ItinContact { id: string; full_name: string | null; email: string | null }

export interface ItinApplicantDeps {
  linkedContacts: (accountId: string) => Promise<ItinContact[]>
  contact: (contactId: string) => Promise<ItinContact | null>
}

export interface ItinApplicantResult { ok: boolean; contactId: string | null; fullName: string | null; message: string }

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ")

const REFUSAL = "Could not tell with certainty which person this ITIN is for, so nothing was generated. Open the form, link it to the right person (same name and email as the person who filled it), and try again."
const CONTRADICTION = "The email on this form belongs to one member but the name is another member's, so nothing was generated. Correct the email on the form or link the form to the right person, then try again."

/**
 * Who filled the form? Two independent signals are read: the NAME (the shared person-name matcher, which ignores case, accents,
 * apostrophes, name order and a left-out middle name) and the EMAIL. An email alone is NEVER enough — a couple can share one
 * address, and a member can type their spouse's. Rules:
 *  - name AND email agree on one member -> that member (the form's own data is the strongest proof);
 *  - the name picks one member and the email points at another -> refuse (contradiction);
 *  - only the name picks one member -> that member, unless staff linked the form to somebody else;
 *  - only the email picks one member -> that member only when staff linked the form to them;
 *  - nothing picks anybody -> the member staff linked the form to (must be a member of this company);
 *  - anything else -> refuse.
 */
export async function resolveItinApplicant(
  sub: { contact_id: string | null; account_id: string | null; submitted_data: Record<string, unknown> | null },
  deps: ItinApplicantDeps,
): Promise<ItinApplicantResult> {
  const data = sub.submitted_data ?? {}
  const email = norm(data.email)
  const formName = `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim()
  const refuse = (message = REFUSAL): ItinApplicantResult => ({ ok: false, contactId: null, fullName: null, message })
  const pick = (c: ItinContact): ItinApplicantResult => ({ ok: true, contactId: c.id, fullName: c.full_name, message: "" })

  if (!sub.account_id) {
    // A form started from a lead: the person the form is linked to (matched by the lead's email, or written back by the form-completed step).
    if (!sub.contact_id) return refuse()
    const c = await deps.contact(sub.contact_id)
    return c ? pick(c) : refuse()
  }

  const { namesMatch } = await import("@/lib/crm-store/lead-form-store")
  const linked = await deps.linkedContacts(sub.account_id)
  const byEmail = email ? linked.filter((c) => norm(c.email) === email) : []
  const byName = formName ? linked.filter((c) => namesMatch(formName, c.full_name)) : []
  const both = byName.filter((c) => byEmail.some((e) => e.id === c.id))

  if (both.length === 1) return pick(both[0])
  if (byName.length === 1) {
    if (byEmail.length > 0) return refuse(CONTRADICTION) // the email belongs to somebody else
    if (!sub.contact_id || sub.contact_id === byName[0].id) return pick(byName[0])
    return refuse() // the name says one member, staff linked another
  }
  if (byName.length === 0 && byEmail.length === 1) {
    return sub.contact_id === byEmail[0].id ? pick(byEmail[0]) : refuse()
  }
  if (byName.length === 0 && byEmail.length === 0 && sub.contact_id) {
    const linkedTo = linked.find((c) => c.id === sub.contact_id)
    if (linkedTo) return pick(linkedTo)
  }
  return refuse()
}

export async function realItinApplicantDeps(): Promise<ItinApplicantDeps> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return {
    linkedContacts: async (accountId) => {
      const { data: links, error } = await supabaseAdmin.from("account_contacts").select("contact_id").eq("account_id", accountId)
      if (error) throw new Error(`Could not read the company's members — ${error.message}`)
      const ids = ((links ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id)
      if (ids.length === 0) return []
      const { data, error: cErr } = await supabaseAdmin.from("contacts").select("id, full_name, email").in("id", ids)
      if (cErr) throw new Error(`Could not read the company's members — ${cErr.message}`)
      return (data ?? []) as ItinContact[]
    },
    contact: async (id) => {
      const { data, error } = await supabaseAdmin.from("contacts").select("id, full_name, email").eq("id", id).maybeSingle()
      if (error) throw new Error(`Could not read the person — ${error.message}`)
      return (data as ItinContact | null) ?? null
    },
  }
}
