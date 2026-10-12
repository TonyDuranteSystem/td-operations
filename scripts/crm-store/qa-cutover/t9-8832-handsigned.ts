/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * Phase 3 QA t9: Form 8832 signed webhook, and the hand-signed Operating Agreement (draft copy + client's scan), for the
 * switched fixture company. SANDBOX only.
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { NextRequest } from "next/server"
import { call, check, form, realPdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const clientUx = await sessionCookie("clientUx")
  // /api/8832-signed is not on the middleware public list (a separate, pre-existing problem), so call its handler directly
  const hook = async (formId: string, token: string) => {
    const { POST } = await import("../../../app/api/8832-signed/route")
    const res = await POST(new NextRequest("http://localhost/api/8832-signed", { method: "POST", body: JSON.stringify({ form_id: formId, token }) }))
    const text = await res.text()
    let json: unknown = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }
  const rows = async () => ((await sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name, file_name").eq("account_id", UX).gt("created_at", t0)).data ?? []) as Array<{ id: string; drive_file_id: string; portal_visible: boolean; document_type_name: string; file_name: string }>

  await sb.storage.createBucket("signed-8832", { public: false }) // the sandbox lacks this bucket; production has it (ignore "already exists")

  // ── Form 8832 ──────────────────────────────────────────────────────────────────────────────────────────────
  const tok = `qa-${randomBytes(6).toString("hex")}-8832`
  const ins = await sb.from("form_8832_applications").insert({ token: tok, access_code: "123456", account_id: UX, contact_id: UX_CONTACT, company_name: "Uxio Test LLC", entity_type: "SMLLC", owner_name: "QA Test", ein: "00-0000000", status: "signed" }).select("id").single()
  if (ins.error) console.log("      fixture 8832 insert failed:", ins.error.message)
  else {
    const up8 = await sb.storage.from("signed-8832").upload(`${tok}/signed.pdf`, await realPdf("signed 8832"), { contentType: "application/pdf", upsert: true })
    if (up8.error) console.log("      fixture 8832 upload failed:", up8.error.message)
    const r = await hook(ins.data.id, tok)
    const steps = ((r.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
    const up = steps.find((s) => s.step === "drive_upload")
    check("F1 8832 webhook: signed PDF saved in the new storage", r.status === 200 && up?.status === "ok" && /new storage/.test(up?.detail ?? ""), `HTTP ${r.status} ${JSON.stringify(up)}`)
    const doc = (await rows()).find((d) => d.document_type_name === "Form 8832")
    check("F2 CRM row: pointer, visible to the client", !!doc && doc.drive_file_id.startsWith("store:") && doc.portal_visible === true, JSON.stringify(doc))
    if (doc) check("F3 the client opens it", (await call(`/api/portal/documents/${doc.id}`, { cookie: clientUx })).status === 200, "")
    const b = (await rows()).filter((d) => d.document_type_name === "Form 8832").length
    await hook(ins.data.id, tok)
    check("F4 retry keeps one row", (await rows()).filter((d) => d.document_type_name === "Form 8832").length === b, `rows ${b}`)
    // the PDF missing from the bucket is no longer a silent skip
    const tok2 = `${tok}-b`
    const ins2 = await sb.from("form_8832_applications").insert({ token: tok2, access_code: "123456", account_id: UX, contact_id: UX_CONTACT, company_name: "Uxio Test LLC", entity_type: "SMLLC", owner_name: "QA Test", ein: "00-0000000", status: "signed" }).select("id").single()
    const miss = await hook(ins2.data.id, tok2)
    const missStep = ((miss.json as { results?: Array<{ step: string; status: string }> } | null)?.results ?? []).find((s) => s.step === "drive_upload")
    check("F5 a missing signed PDF is reported as an error step, not skipped silently", missStep?.status === "error", JSON.stringify(missStep))
  }

  // ── hand-signed Operating Agreement ────────────────────────────────────────────────────────────────────────
  const otok = `qa-${randomBytes(6).toString("hex")}-oa`
  const oa = await sb.from("oa_agreements").insert({
    token: otok, access_code: "123456", account_id: UX, contact_id: UX_CONTACT, company_name: "Uxio Test LLC", state_of_formation: "FL", formation_date: "2026-01-01", ein_number: "00-0000000",
    member_name: "QA Test", member_address: "QA Test address", member_email: "qa-test@example.test", member_ownership_pct: 100, effective_date: "2026-01-01", business_purpose: "any lawful",
    initial_contribution: "$0", fiscal_year_end: "December 31", accounting_method: "Cash", duration: "Perpetual", registered_agent_name: "QA", registered_agent_address: "QA", principal_address: "QA",
    status: "sent", language: "en", entity_type: "SMLLC", manager_name: "QA Test", total_signers: 1, signed_count: 0,
  }).select("id").single()
  if (oa.error) console.log("      fixture OA insert failed:", oa.error.message)
  else {
    const f = form({ code: "123456" }, { name: "QA Test scan.pdf", data: await realPdf("hand signed scan"), type: "application/pdf" })
    const r = await call(`/api/operating-agreement/${otok}/hand-signed`, { form: f })
    check("H1 hand-signed declaration accepted", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`)
    const docs = (await rows()).filter((d) => d.document_type_name === "Operating Agreement" && /hand/i.test(d.file_name))
    check("H2 two files in the new storage: the unsigned copy and the client's scan", docs.length === 2 && docs.every((d) => d.drive_file_id.startsWith("store:") && d.portal_visible === true), JSON.stringify(docs))
    check("H3 each is its own file (not one overwriting the other)", new Set(docs.map((d) => d.drive_file_id)).size === 2, JSON.stringify(docs.map((d) => d.drive_file_id)))
  }
  const stray = (await rows()).filter((d) => !d.drive_file_id.startsWith("store:"))
  check("Q3 nothing points at a Drive id", stray.length === 0, JSON.stringify(stray))
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
