/* eslint-disable no-console, no-restricted-syntax */
/**
 * Phase 3 QA t11: the e-sign engine completion (finalizeEsignCompletion), the legacy signature-request-signed webhook and
 * the intercompany agreement filing, for the switched fixture (Uxio Test LLC) and a Drive company (Test Company LLC).
 * SANDBOX only. Needs the dev server on :3100. Run: npx tsx scripts/crm-store/qa-cutover/t11-esign-sigreq-intercompany.ts
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { call, check, realPdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const tok = () => `qa-${randomBytes(6).toString("hex")}`

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")
  const { data: tc } = await sb.from("accounts").select("id, drive_folder_id").eq("company_name", "Test Company LLC").maybeSingle()
  const TC = tc?.id as string | undefined
  console.log(`      (info) Test Company LLC id=${TC} drive_folder_id=${tc?.drive_folder_id ?? "null"}`)

  const rowsByPointer = async (pointer: string) => (await sb.from("documents").select("id, drive_file_id, portal_visible, account_id").eq("drive_file_id", pointer)).data as Array<{ id: string; drive_file_id: string; portal_visible: boolean; account_id: string }>
  const rowsSince = async (account: string, name: string) => (await sb.from("documents").select("id, drive_file_id, portal_visible, file_name").eq("account_id", account).eq("file_name", name).gt("created_at", t0)).data as Array<{ id: string; drive_file_id: string; portal_visible: boolean; file_name: string }>

  async function assertVisibleStoreDoc(prefix: string, pointer: string, name: string, account: string, visible: boolean) {
    const byPtr = await rowsByPointer(pointer)
    check(`${prefix}-a pointer starts with store:`, pointer.startsWith("store:"), pointer)
    check(`${prefix}-b exactly ONE documents row for that pointer, portal_visible=${visible}`, byPtr.length === 1 && byPtr[0].portal_visible === visible && byPtr[0].account_id === account, JSON.stringify(byPtr))
    const named = await rowsSince(account, name)
    check(`${prefix}-c exactly one row with the file name (no duplicate, no Drive id)`, named.length === 1 && named[0].drive_file_id.startsWith("store:"), JSON.stringify(named))
    const id = byPtr[0]?.id
    if (!id) return
    const cl = await call(`/api/portal/documents/${id}`, { cookie: clientUx })
    if (visible) check(`${prefix}-d client opens it (200 + bytes)`, cl.status === 200 && cl.bytes.length > 100 && cl.bytes.subarray(0, 4).toString() === "%PDF", `HTTP ${cl.status} bytes=${cl.bytes.length}`)
    else check(`${prefix}-d client gets 404`, cl.status === 404, `HTTP ${cl.status}`)
    const pv = await call(`/api/documents/${id}/preview`, { cookie: staff })
    check(`${prefix}-e staff preview 200`, pv.status === 200, `HTTP ${pv.status} ${pv.text.slice(0, 80).replace(/[^\x20-\x7e]/g, ".")}`)
  }

  // ── (1) e-sign engine ─────────────────────────────────────────────────────────────────────────────────────
  const { createEsignEnvelope, flattenEnvelopeToSignedPdf, finalizeEsignCompletion } = await import("../../../lib/operations/esign")
  async function makeEnvelope(account: string, contact: string | null, docName: string) {
    const env = await createEsignEnvelope({
      document_name: docName, pdfBuffer: await realPdf("esign src"), fileName: "QA_Test_esign.pdf", pageCount: 1,
      fields: [{ field_type: "text", page_index: 0, pos_x: 0.1, pos_y: 0.1, width: 0.3, height: 0.05, signer_index: 0 }],
      signers: [{ name: "QA Test Signer", email: "qa-test@example.test" }], owner_account_id: account, contact_id: contact, created_by: "qa-t11",
    })
    const { signedPath } = await flattenEnvelopeToSignedPdf(env.id)
    const up = await sb.from("esign_envelopes").update({ signed_pdf_path: signedPath, status: "completed", completed_at: new Date().toISOString() }).eq("id", env.id)
    if (up.error) throw new Error(`envelope update failed: ${up.error.message}`)
    return env.id as string
  }
  const getPtr = async (id: string) => (await sb.from("esign_envelopes").select("signed_pdf_drive_id").eq("id", id).single()).data?.signed_pdf_drive_id as string | null

  try {
    const name = `QA Test Esign ${Date.now()}`
    const envId = await makeEnvelope(UX, UX_CONTACT, name)
    await finalizeEsignCompletion(envId)
    const ptr = (await getPtr(envId)) ?? ""
    check("E0 envelope.signed_pdf_drive_id set to a store pointer after completion", ptr.startsWith("store:"), `ptr=${ptr}`)
    await assertVisibleStoreDoc("E1", ptr, `${name} - Signed.pdf`, UX, true)
    await finalizeEsignCompletion(envId)
    const ptr2 = (await getPtr(envId)) ?? ""
    check("E2 second finalize: same pointer, still exactly one row", ptr2 === ptr && (await rowsByPointer(ptr)).length === 1 && (await rowsSince(UX, `${name} - Signed.pdf`)).length === 1, `ptr2=${ptr2}`)
    // simulate a crash after the save but before the pointer was written back: the retry must reuse the same file
    await sb.from("esign_envelopes").update({ signed_pdf_drive_id: null }).eq("id", envId)
    await finalizeEsignCompletion(envId)
    const ptr3 = (await getPtr(envId)) ?? ""
    check("E3 retry after a lost pointer write-back: same store pointer, still ONE row", ptr3 === ptr && (await rowsSince(UX, `${name} - Signed.pdf`)).length === 1, `ptr3=${ptr3}`)
  } catch (e) { check("E-fixture esign switched run", false, e instanceof Error ? e.message : String(e)) }

  if (TC) {
    try {
      const name = `QA Test Esign TC ${Date.now()}`
      const envId = await makeEnvelope(TC, null, name)
      await finalizeEsignCompletion(envId)
      const ptr = (await getPtr(envId)) ?? ""
      const rows = await rowsSince(TC, `${name} - Signed.pdf`)
      console.log(`      (info) Drive company e-sign pointer=${ptr} rows=${JSON.stringify(rows)}`)
      check("E4 Drive company: NO store: pointer anywhere", !ptr.startsWith("store:") && rows.every((r) => !r.drive_file_id.startsWith("store:")), `ptr=${ptr}`)
    } catch (e) { check("E4 esign Drive company run", false, e instanceof Error ? e.message : String(e)) }
  }

  // ── (2) legacy signature-request-signed webhook ───────────────────────────────────────────────────────────
  async function makeSigReq(account: string, contact: string | null, docName: string, sdId: string | null) {
    const token = tok()
    const signedPath = `${token}/signed-${Date.now()}.pdf`
    const upl = await sb.storage.from("signed-documents").upload(signedPath, await realPdf("sigreq"), { contentType: "application/pdf", upsert: true })
    if (upl.error) throw new Error(`signed upload failed: ${upl.error.message}`)
    const ins = await sb.from("signature_requests").insert({ account_id: account, contact_id: contact, token, access_code: tok(), document_name: docName, pdf_storage_path: `${token}/src.pdf`, status: "signed", signed_at: new Date().toISOString(), signed_pdf_path: signedPath, created_by: "qa-t11", service_delivery_id: sdId }).select("id").single()
    if (ins.error) throw new Error(`signature_requests insert failed: ${ins.error.message}`)
    return { id: ins.data.id as string, token }
  }
  const getSrPtr = async (id: string) => (await sb.from("signature_requests").select("signed_pdf_drive_id").eq("id", id).single()).data?.signed_pdf_drive_id as string | null

  try {
    const name = `QA Test SigReq ${Date.now()}`
    const sr = await makeSigReq(UX, UX_CONTACT, name, null)
    const r = await call("/api/signature-request-signed", { json: { signature_request_id: sr.id, token: sr.token } })
    const results = (r.json as { results?: string[] } | null)?.results ?? []
    console.log(`      (info) results: ${results.join(" | ")}`)
    check("S0 webhook 200 and storage_save ok", r.status === 200 && results.includes("storage_save: ok"), `HTTP ${r.status} ${r.text.slice(0, 200)}`)
    const ptr = (await getSrPtr(sr.id)) ?? ""
    await assertVisibleStoreDoc("S1", ptr, `${name} - Signed.pdf`, UX, true)
    const r2 = await call("/api/signature-request-signed", { json: { signature_request_id: sr.id, token: sr.token } })
    const ptr2 = (await getSrPtr(sr.id)) ?? ""
    check("S2 second webhook call: same pointer, still ONE row", r2.status === 200 && ptr2 === ptr && (await rowsByPointer(ptr)).length === 1 && (await rowsSince(UX, `${name} - Signed.pdf`)).length === 1, `HTTP ${r2.status} ptr2=${ptr2}`)
  } catch (e) { check("S-fixture sigreq switched run", false, e instanceof Error ? e.message : String(e)) }

  try {
    const { data: sd } = await sb.from("service_deliveries").select("id, stage").eq("account_id", UX).limit(1).maybeSingle()
    if (!sd) console.log("      (skip) no service delivery for the fixture; flow_stage stamp not tested")
    else {
      const name = `QA Test SigReq SD ${Date.now()}`
      const sr = await makeSigReq(UX, UX_CONTACT, name, sd.id)
      const r = await call("/api/signature-request-signed", { json: { signature_request_id: sr.id, token: sr.token } })
      const ptr = (await getSrPtr(sr.id)) ?? ""
      const rows = await rowsByPointer(ptr)
      const { data: full } = await sb.from("documents").select("flow_stage, service_delivery_id").eq("id", rows[0]?.id ?? "00000000-0000-0000-0000-000000000000").maybeSingle()
      check("S3 flow-bound request: store row stamped with the SD + flow_stage Signed, one row", r.status === 200 && rows.length === 1 && full?.flow_stage === "Signed" && full?.service_delivery_id === sd.id, `HTTP ${r.status} ${JSON.stringify(full)} rows=${rows.length}`)
    }
  } catch (e) { check("S3 sigreq with SD", false, e instanceof Error ? e.message : String(e)) }

  if (TC) {
    try {
      const name = `QA Test SigReq TC ${Date.now()}`
      const sr = await makeSigReq(TC, null, name, null)
      const r = await call("/api/signature-request-signed", { json: { signature_request_id: sr.id, token: sr.token } })
      const ptr = (await getSrPtr(sr.id)) ?? ""
      const rows = await rowsSince(TC, `${name} - Signed.pdf`)
      console.log(`      (info) Drive company sigreq results=${JSON.stringify((r.json as { results?: string[] } | null)?.results)} ptr=${ptr} rows=${JSON.stringify(rows)}`)
      check("S4 Drive company: NO store: pointer anywhere", r.status === 200 && !ptr.startsWith("store:") && rows.every((x) => !x.drive_file_id.startsWith("store:")), `HTTP ${r.status}`)
    } catch (e) { check("S4 sigreq Drive company run", false, e instanceof Error ? e.message : String(e)) }
  }

  // ── (3) intercompany agreement ────────────────────────────────────────────────────────────────────────────
  const { generateIntercompanyForAccount } = await import("../../../lib/operations/intercompany")
  const added: Array<{ table: string; id: string }> = []
  async function ensureTreasury(account: string, name: string, pct: number) {
    const hasAcc = (await sb.from("accounts").select("id").ilike("company_name", name).limit(1).maybeSingle()).data
    if (!hasAcc) {
      const a = await sb.from("accounts").insert({ company_name: name, state_of_formation: "Delaware", physical_address: "1 QA Test Way, Wilmington, DE 19801" }).select("id").single()
      if (a.error) throw new Error(`treasury account insert failed: ${a.error.message}`)
      added.push({ table: "accounts", id: a.data.id })
    }
    const existing = (await sb.from("members").select("id").eq("account_id", account).eq("member_type", "company").eq("company_name", name).maybeSingle()).data
    if (!existing) {
      const m = await sb.from("members").insert({ account_id: account, member_type: "company", company_name: name, ownership_pct: pct, is_primary: false, address_street: "1 QA Test Way", address_city: "Wilmington", address_state: "DE", address_zip: "19801", address_country: "USA" }).select("id").single()
      if (m.error) throw new Error(`treasury member insert failed: ${m.error.message}`)
      added.push({ table: "members", id: m.data.id })
    }
  }
  try {
    const TREAS = "QA Test Treasury LLC"
    await ensureTreasury(UX, TREAS, 99)
    const effective = new Date().toISOString().slice(0, 10)
    const g1 = await generateIntercompanyForAccount(UX, { effective_date: effective, actor: "qa-t11" })
    console.log(`      (info) g1=${JSON.stringify(g1)}`)
    check("I0 generation succeeded", g1.success === true, JSON.stringify(g1))
    const ptr = g1.drive_file_id ?? ""
    await assertVisibleStoreDoc("I1", ptr, g1.file_name ?? "?", UX, true)
    const g2 = await generateIntercompanyForAccount(UX, { effective_date: effective, actor: "qa-t11" })
    check("I2 regenerate: same store pointer (new version), still ONE row", g2.success === true && g2.drive_file_id === ptr && (await rowsByPointer(ptr)).length === 1 && (await rowsSince(UX, g1.file_name ?? "?")).length === 1, JSON.stringify(g2))
  } catch (e) { check("I-fixture intercompany switched run", false, e instanceof Error ? e.message : String(e)) }

  if (TC) {
    try {
      const { data: cm } = await sb.from("members").select("company_name").eq("account_id", TC).eq("member_type", "company")
      const acmeName = cm?.[0]?.company_name as string | undefined
      if (acmeName) {
        const has = (await sb.from("accounts").select("id").ilike("company_name", acmeName).limit(1).maybeSingle()).data
        if (!has) {
          const a = await sb.from("accounts").insert({ company_name: acmeName, state_of_formation: "Delaware", physical_address: "2 QA Test Way, Wilmington, DE 19801" }).select("id").single()
          if (a.error) throw new Error(`acme account insert failed: ${a.error.message}`)
          added.push({ table: "accounts", id: a.data.id })
        }
      }
      const before = (await sb.from("documents").select("id").eq("account_id", TC).gt("created_at", t0)).data?.length ?? 0
      const g = await generateIntercompanyForAccount(TC, { actor: "qa-t11" })
      console.log(`      (info) Drive company intercompany=${JSON.stringify(g)}`)
      const after = (await sb.from("documents").select("id, drive_file_id").eq("account_id", TC).gt("created_at", t0)).data as Array<{ id: string; drive_file_id: string }>
      check("I3 Drive company: NO store: pointer (result or rows)", !(g.drive_file_id ?? "").startsWith("store:") && after.every((d) => !d.drive_file_id.startsWith("store:")), `before=${before} after=${after.length} result=${JSON.stringify(g).slice(0, 200)}`)
    } catch (e) { check("I3 intercompany Drive company run", false, e instanceof Error ? e.message : String(e)) }
  }
  console.log(`      (info) fixture rows left in sandbox: ${JSON.stringify(added)}`)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
