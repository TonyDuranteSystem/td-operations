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

/** Compare people without being fooled by case, accents, curly apostrophes or double spaces ("D’Angelo" = "D'Angelo"). */
const norm = (s: unknown) => String(s ?? "")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'")
  .trim().toLowerCase().replace(/\s+/g, " ")

const REFUSAL = "Could not tell with certainty which person this ITIN is for, so nothing was generated. Open the form, link it to the right person (same email as the person who filled it), and try again."

export async function resolveItinApplicant(
  sub: { contact_id: string | null; account_id: string | null; submitted_data: Record<string, unknown> | null },
  deps: ItinApplicantDeps,
): Promise<ItinApplicantResult> {
  const data = sub.submitted_data ?? {}
  const email = norm(data.email)
  const formName = norm(`${data.first_name ?? ""} ${data.last_name ?? ""}`)
  const refuse = (): ItinApplicantResult => ({ ok: false, contactId: null, fullName: null, message: REFUSAL })
  const pick = (c: ItinContact): ItinApplicantResult => ({ ok: true, contactId: c.id, fullName: c.full_name, message: "" })

  if (!sub.account_id) {
    // A form started from a lead: the person the form is linked to (matched by the lead's email, or written back by the form-completed step).
    if (!sub.contact_id) return refuse()
    const c = await deps.contact(sub.contact_id)
    return c ? pick(c) : refuse()
  }

  const linked = await deps.linkedContacts(sub.account_id)
  // 1. the person's email, then 2. their exact name — each must name exactly ONE member; a shared email falls through to the name
  let pool = linked
  if (email) {
    const byEmail = linked.filter((c) => norm(c.email) === email)
    if (byEmail.length === 1) return pick(byEmail[0])
    if (byEmail.length > 1) pool = byEmail
  }
  if (formName) {
    const byName = pool.filter((c) => norm(c.full_name) === formName)
    if (byName.length === 1) return pick(byName[0])
    if (pool !== linked) {
      const byNameAll = linked.filter((c) => norm(c.full_name) === formName)
      if (byNameAll.length === 1 && pool.some((c) => c.id === byNameAll[0].id)) return pick(byNameAll[0])
    }
  }
  // 3. nothing in the form identifies a member: honour the person staff linked the form to — but only a member of this company
  if (sub.contact_id) {
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
