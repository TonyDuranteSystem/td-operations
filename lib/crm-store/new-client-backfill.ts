/**
 * Bring ONE new client who signed/paid BEFORE the new-clients switch was turned on into the new storage
 * (Drive cutover batch B go-live step; dev job ad09ea91). Owners only, one contact at a time, idempotent.
 *
 *  1. the signed contract (still only in the signed-contracts bucket) → the contact's own storage, hidden from the client,
 *     under the SAME key the signing step uses (`offer-signed:<offer id>`), so running this twice — or after a normal signing —
 *     never makes a second copy;
 *  2. an active Company Formation case of the contact with no company yet and no storage → its company-in-formation storage.
 *
 * Only a genuinely new client (no company, no Drive contact folder — `contactIsNewClient`) is touched; anyone else is refused
 * with a plain reason. Needs STORE_NEW_CLIENTS=1.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface BackfillStep { what: string; status: "done" | "already" | "skipped" | "error"; detail: string }
export interface BackfillPlan { allowed: boolean; reason?: string; contactName?: string; contracts: Array<{ offerId: string; token: string; hasPdf: boolean }>; formations: Array<{ caseId: string; hasStorage: boolean }> }

export class BackfillRefused extends Error {}

export async function planNewClientBackfill(contactId: string): Promise<BackfillPlan> {
  const f = await import("./formation-pilot")
  if (!f.newClientsLive()) return { allowed: false, reason: "New clients in the new storage is switched off in this environment.", contracts: [], formations: [] }
  const { data: c, error } = await supabaseAdmin.from("contacts").select("id, full_name, email").eq("id", contactId).maybeSingle()
  if (error || !c) return { allowed: false, reason: "Contact not found.", contracts: [], formations: [] }
  if (!(await f.contactIsNewClient(contactId))) {
    return { allowed: false, reason: "This person is not a brand-new client (they already have a company or a Drive folder) — they stay where they are until their companies switch.", contactName: c.full_name ?? undefined, contracts: [], formations: [] }
  }
  const filters = [`contact_id.eq.${contactId}`]
  if (c.email) filters.push(`client_email.eq.${String(c.email).replace(/[,()]/g, "")}`)
  const { data: offers } = await supabaseAdmin.from("offers").select("id, token, status, account_id").or(filters.join(",")).in("status", ["signed", "completed"]).is("account_id", null)
  const contracts: BackfillPlan["contracts"] = []
  for (const o of offers ?? []) {
    const { data: k } = await supabaseAdmin.from("contracts").select("pdf_path").eq("offer_token", o.token).order("created_at", { ascending: false }).limit(1).maybeSingle()
    contracts.push({ offerId: o.id as string, token: o.token as string, hasPdf: !!k?.pdf_path })
  }
  const { data: sds } = await supabaseAdmin.from("service_deliveries").select("id").eq("contact_id", contactId).eq("service_type", "Company Formation").eq("status", "active").is("account_id", null)
  const formations: BackfillPlan["formations"] = []
  for (const s of sds ?? []) formations.push({ caseId: s.id as string, hasStorage: !!(await f.storeOwnerForCase(s.id as string)) })
  return { allowed: true, contactName: c.full_name ?? undefined, contracts, formations }
}

export async function runNewClientBackfill(contactId: string): Promise<{ plan: BackfillPlan; steps: BackfillStep[] }> {
  const plan = await planNewClientBackfill(contactId)
  if (!plan.allowed) throw new BackfillRefused(plan.reason ?? "Not allowed.")
  const f = await import("./formation-pilot")
  const steps: BackfillStep[] = []

  for (const k of plan.contracts) {
    if (!k.hasPdf) { steps.push({ what: `contract of offer ${k.token}`, status: "skipped", detail: "no signed PDF on file" }); continue }
    try {
      const { data: kc } = await supabaseAdmin.from("contracts").select("pdf_path").eq("offer_token", k.token).order("created_at", { ascending: false }).limit(1).maybeSingle()
      const { data: blob, error: dErr } = await supabaseAdmin.storage.from("signed-contracts").download(kc!.pdf_path as string)
      if (dErr || !blob) throw new Error(`could not read the signed PDF (${dErr?.message ?? "no data"})`)
      const { data: o } = await supabaseAdmin.from("offers").select("client_name").eq("id", k.offerId).maybeSingle()
      const { saveDocumentForContact } = await import("./save-for-account")
      await f.ensurePersonOwner(contactId, plan.contactName || (o?.client_name as string | null) || "New client")
      const routed = await saveDocumentForContact({
        contactId,
        name: `Contract - ${(o?.client_name as string | null) ?? plan.contactName ?? "client"} (Signed).pdf`,
        bytes: Buffer.from(await blob.arrayBuffer()),
        mimeType: "application/pdf",
        documentType: "other_document",
        callerKey: `offer-signed:${k.offerId}`,
        row: { document_type_name: "Signed Contract", category: 5, status: "classified" },
      })
      if (routed.route !== "store") throw new Error("the person's storage could not be opened")
      steps.push({ what: `contract of offer ${k.token}`, status: routed.status === "unchanged" ? "already" : "done", detail: routed.pointer })
    } catch (e) {
      steps.push({ what: `contract of offer ${k.token}`, status: "error", detail: e instanceof Error ? e.message : String(e) })
    }
  }

  for (const fc of plan.formations) {
    if (fc.hasStorage) { steps.push({ what: `formation ${fc.caseId}`, status: "already", detail: "company-in-formation storage exists" }); continue }
    try {
      const { data: sd } = await supabaseAdmin.from("service_deliveries").select("id, contact_id, account_id, service_type").eq("id", fc.caseId).single()
      const owner = await f.ensureFormationStorageAtPayment({ id: sd!.id as string, contact_id: (sd!.contact_id as string | null) ?? null, account_id: null, service_type: sd!.service_type as string })
      steps.push(owner ? { what: `formation ${fc.caseId}`, status: "done", detail: "company-in-formation storage opened" } : { what: `formation ${fc.caseId}`, status: "error", detail: "storage could not be opened (an alarm was raised)" })
    } catch (e) {
      steps.push({ what: `formation ${fc.caseId}`, status: "error", detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return { plan, steps }
}
