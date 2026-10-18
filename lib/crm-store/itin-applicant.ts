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

export interface ItinApplicantResult { ok: boolean; contactId: string | null; message: string }

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ")

const REFUSAL = "Could not tell with certainty which person this ITIN is for, so nothing was generated. Open the form, link it to the right person (same email as the person who filled it), and try again."

export async function resolveItinApplicant(
  sub: { contact_id: string | null; account_id: string | null; submitted_data: Record<string, unknown> | null },
  deps: ItinApplicantDeps,
): Promise<ItinApplicantResult> {
  const data = sub.submitted_data ?? {}
  const email = norm(data.email)
  const fullName = norm(`${data.first_name ?? ""} ${data.last_name ?? ""}`)
  const refuse = (): ItinApplicantResult => ({ ok: false, contactId: null, message: REFUSAL })

  if (!sub.account_id) {
    // A form started from a lead: the person was matched by the lead's email when the form was created.
    if (!sub.contact_id) return refuse()
    const c = await deps.contact(sub.contact_id)
    return c ? { ok: true, contactId: c.id, message: "" } : refuse()
  }

  const linked = await deps.linkedContacts(sub.account_id)
  if (email) {
    const byEmail = linked.filter((c) => norm(c.email) === email)
    if (byEmail.length === 1) return { ok: true, contactId: byEmail[0].id, message: "" }
    if (byEmail.length > 1) return refuse()
  }
  if (fullName) {
    const byName = linked.filter((c) => norm(c.full_name) === fullName)
    if (byName.length === 1) return { ok: true, contactId: byName[0].id, message: "" }
    if (byName.length > 1) return refuse()
  }
  // One member only, and the form is linked to exactly that member: nobody else it could be.
  if (linked.length === 1 && sub.contact_id && linked[0].id === sub.contact_id) return { ok: true, contactId: sub.contact_id, message: "" }
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
      const { data } = await supabaseAdmin.from("contacts").select("id, full_name, email").eq("id", id).maybeSingle()
      return (data as ItinContact | null) ?? null
    },
  }
}
