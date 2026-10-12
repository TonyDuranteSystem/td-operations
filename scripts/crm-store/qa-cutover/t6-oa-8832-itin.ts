/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * Phase 3 QA t6: Operating Agreement signed webhook, retry, for the switched fixture company. SANDBOX only.
 * Needs the dev server started with INTERNAL_WEBHOOK_SECRET=qa-local-secret.
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { call, check, realPdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const H = { "x-internal-webhook-secret": "qa-local-secret" }

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const clientUx = await sessionCookie("clientUx")
  const rows = async () => ((await sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name").eq("account_id", UX).gt("created_at", t0)).data ?? []) as Array<{ id: string; drive_file_id: string; portal_visible: boolean; document_type_name: string }>

  const token = `qa-${randomBytes(6).toString("hex")}-oa`
  const ins = await sb.from("oa_agreements").insert({
    token, account_id: UX, contact_id: UX_CONTACT, company_name: "Uxio Test LLC", state_of_formation: "FL", formation_date: "2026-01-01", ein_number: "00-0000000",
    member_name: "QA Test", member_address: "QA Test address", member_email: "qa-test@example.test", member_ownership_pct: 100, effective_date: "2026-01-01",
    business_purpose: "any lawful", initial_contribution: "$0", fiscal_year_end: "December 31", accounting_method: "Cash", duration: "Perpetual",
    registered_agent_name: "QA", registered_agent_address: "QA", principal_address: "QA", status: "signed", language: "en", entity_type: "SMLLC", manager_name: "QA Test",
    total_signers: 1, signed_count: 1, pdf_storage_path: `${token}/oa-signed.pdf`,
  }).select("id").single()
  if (ins.error) { console.log("      fixture OA insert failed:", ins.error.message); return }
  await sb.storage.from("signed-oa").upload(`${token}/oa-signed.pdf`, await realPdf("signed OA"), { contentType: "application/pdf", upsert: true })

  const r = await call("/api/oa-signed", { json: { oa_id: ins.data.id, token }, headers: H })
  const steps = ((r.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
  const up = steps.find((s) => s.step === "drive_upload")
  check("OA1 webhook accepted and filed in the new storage", r.status === 200 && up?.status === "ok" && /new storage/.test(up?.detail ?? ""), `HTTP ${r.status} ${JSON.stringify(up)}`)
  const doc = (await rows()).find((d) => d.document_type_name === "Operating Agreement")
  check("OA2 CRM row: pointer, visible to the client", !!doc && doc.drive_file_id.startsWith("store:") && doc.portal_visible === true, JSON.stringify(doc))
  if (doc) {
    const o = await call(`/api/portal/documents/${doc.id}`, { cookie: clientUx })
    check("OA3 the client opens the signed OA", o.status === 200 && o.bytes.length > 10, `HTTP ${o.status}`)
  }
  const before = (await rows()).filter((d) => d.document_type_name === "Operating Agreement").length
  await call("/api/oa-signed", { json: { oa_id: ins.data.id, token }, headers: H })
  const after = (await rows()).filter((d) => d.document_type_name === "Operating Agreement").length
  check("OA4 retry keeps one row", before === after, `${before} → ${after}`)
  const bad = await call("/api/oa-signed", { json: { oa_id: ins.data.id, token } })
  check("OA5 without the internal secret the webhook refuses", bad.status === 401, `HTTP ${bad.status}`)
  check("Q3 nothing points at a Drive id", (await rows()).every((d) => d.drive_file_id.startsWith("store:")), JSON.stringify(await rows()))
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
