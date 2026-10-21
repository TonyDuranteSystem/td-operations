/**
 * Filling in the name, email and phone of leads that were stored without them (TD Marketing, dev job 9aec66fa). Found 2026-10-21: Antonio's Meta form
 * names its fields in Italian ("nome_e_cognome", "e-mail", "numero_di_telefono"), which the first version of the lead mapper did not recognise, so every
 * real lead was stored with no name, email or phone although every answer was kept. The mapper is fixed (map-lead.ts); this fills in the leads already stored,
 * from the answers kept with each lead, then runs the existing-client hint on them as a new lead would have. Admin-run, two steps: a dry run that only counts,
 * then the real thing. Never overwrites a value that is already there.
 */
import { findExistingClient, type Db } from "@/lib/marketing/meta-leads/ingest"
import { extractContact, type LeadAnswer } from "@/lib/marketing/meta-leads/map-lead"

export interface BackfillLead { id: string; full_name: string | null; email: string | null; phone: string | null; country: string | null; city: string | null; answers: LeadAnswer[] | null }
export interface BackfillPatch { fullName?: string; email?: string; phone?: string; country?: string; city?: string }

/** What would be filled for one lead. Only empty columns are ever filled; null when there is nothing to fill. */
export function planLeadBackfill(l: BackfillLead): BackfillPatch | null {
  if (!Array.isArray(l.answers) || l.answers.length === 0) return null
  const c = extractContact(l.answers)
  const patch: BackfillPatch = {}
  if (!l.full_name && c.fullName) patch.fullName = c.fullName
  if (!l.email && c.email) patch.email = c.email
  if (!l.phone && c.phone) patch.phone = c.phone
  if (!l.country && c.country) patch.country = c.country
  if (!l.city && c.city) patch.city = c.city
  return Object.keys(patch).length ? patch : null
}

export interface BackfillReport {
  apply: boolean
  /** leads with no name, email and phone at all */
  withoutDetails: number
  /** leads that would be / were filled */
  filled: number
  names: number
  emails: number
  phones: number
  /** Meta's own "Test lead" button leads (named "Meta test lead") */
  testLeads: number
  /** leads that look like an existing TD client once their details are known */
  existingClients: number
  /** leads where saving failed (nothing half-written is left: each lead is one update) */
  failed: number
}

const COLS = "id, full_name, email, phone, country, city, answers"
const toColumns = (p: BackfillPatch) => ({
  ...(p.fullName ? { full_name: p.fullName } : {}), ...(p.email ? { email: p.email } : {}), ...(p.phone ? { phone: p.phone } : {}),
  ...(p.country ? { country: p.country } : {}), ...(p.city ? { city: p.city } : {}),
})

export async function runContactBackfill(db: Db, opts: { apply: boolean; limit?: number; now?: () => Date }): Promise<BackfillReport> {
  const r: BackfillReport = { apply: opts.apply, withoutDetails: 0, filled: 0, names: 0, emails: 0, phones: 0, testLeads: 0, existingClients: 0, failed: 0 }
  // Only leads with NO name, email or phone: a lead someone has already worked on, or that already has details, is left alone.
  const { data } = await db.from("marketing_leads").select(COLS).is("full_name", null).is("email", null).is("phone", null).order("received_at", { ascending: true }).limit(opts.limit ?? 5000)
  const leads = (data ?? []) as BackfillLead[]
  r.withoutDetails = leads.length
  const nowIso = (opts.now ?? (() => new Date()))().toISOString()
  for (const l of leads) {
    const patch = planLeadBackfill(l)
    if (!patch) continue
    const client = await findExistingClient(db, { email: patch.email ?? null, phone: patch.phone ?? null })
    r.filled++
    if (patch.fullName) r.names++
    if (patch.email) r.emails++
    if (patch.phone) r.phones++
    if (patch.fullName === "Meta test lead") r.testLeads++
    if (client && !client.check_failed && client.contact_ids.length) r.existingClients++
    if (!opts.apply) continue
    // one update per lead, guarded so a value that appeared meanwhile is never overwritten
    const upd = await db.from("marketing_leads").update({ ...toColumns(patch), ...(client ? { existing_client: client } : {}), updated_at: nowIso })
      .eq("id", l.id).is("full_name", null).is("email", null).is("phone", null).select("id")
    if (upd.error || !upd.data || upd.data.length === 0) { r.failed++; continue }
    await db.from("marketing_lead_events").insert({ lead_id: l.id, kind: "details_filled", actor: "system", data: { fields: Object.keys(toColumns(patch)) } })
    if (client) await db.from("marketing_lead_events").insert({ lead_id: l.id, kind: client.check_failed ? "client_check_failed" : "possible_existing_client", actor: "system", data: client })
  }
  return r
}
