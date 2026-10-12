/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * Phase 3 QA t12 (dev job ad09ea91): Phase-2 save points that had no QA yet, for the switched fixture company (Uxio Test LLC):
 * renewal receipt (file-renewal), signed offer contract (process-offer-signed), confirmed tax workbook (attest-handoff),
 * and the READERS that must open a store: pointer (openDocument, signature PDF route, prior-return extractor, email attachments).
 * Real handlers, real sandbox DB. SANDBOX only. Run: npx tsx scripts/crm-store/qa-cutover/t12-renewal-offer-tax-readers.ts
 */
import { config } from "dotenv"
import { randomBytes, randomUUID } from "crypto"
import { call, check, realPdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const tok = () => `qa-t12-${randomBytes(5).toString("hex")}`
const isPdf = (b: Buffer) => b.subarray(0, 5).toString("utf8") === "%PDF-"

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  if (process.env.SANDBOX_MODE !== "1") throw new Error("refusing to run: SANDBOX_MODE must be 1 (email must be blocked)")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const clientUx = await sessionCookie("clientUx")
  const docsByName = async (like: string, type?: string) => {
    let q = sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name, file_name, account_id").eq("account_id", UX).like("file_name", like)
    if (type) q = q.eq("document_type_name", type)
    return ((await q).data ?? []) as Array<{ id: string; drive_file_id: string; portal_visible: boolean; document_type_name: string; file_name: string; account_id: string }>
  }
  const portalOpen = async (id: string) => (await call(`/api/portal/documents/${id}`, { cookie: clientUx })).status

  // ───────────────────────── (1) renewal receipt ─────────────────────────
  const { data: acctBefore } = await sb.from("accounts").select("ra_renewal_date, annual_report_due_date, notes").eq("id", UX).single()
  let renewalPointer = ""
  let renewalDocId = ""
  const staff = await sessionCookie("staff")
  const resetAccount = () => sb.from("accounts").update({ ra_renewal_date: "2031-11-15", annual_report_due_date: acctBefore.annual_report_due_date, notes: acctBefore.notes }).eq("id", UX)
  try {
    await resetAccount() // cycle year 2031 (a fresh year for the receipt file name); restored in finally
    const mk = async () => call("/api/crm/renewal/file", { cookie: staff, json: { account_id: UX, delivery_id: null, kind: "ra", filed_date: "2026-10-12", receipt: { file_name: "QA Test receipt.pdf", mime_type: "application/pdf", data_base64: (await realPdf("renewal receipt")).toString("base64") } } })
    const r1 = await mk()
    const d1 = r1.json as { ok?: boolean; drive_file_id?: string; drive_link?: string; document_id?: string } | null
    check("R1 filing a renewal (staff route) succeeds for the switched company, no Drive folder needed", r1.status === 200 && d1?.ok === true, "HTTP " + r1.status + " " + r1.text.slice(0, 250))
    const rows1 = await docsByName("RA Renewal 2031%")
    check("R2 receipt is ONE store: document row, shown to the client", rows1.length === 1 && rows1[0].drive_file_id.startsWith("store:") && rows1[0].portal_visible === true, JSON.stringify(rows1))
    check("R3 result drive_file_id is the pointer, link is the preview route (not a Drive URL)", !!d1 && d1.drive_file_id === rows1[0]?.drive_file_id && String(d1.drive_link).startsWith("/api/documents/") && d1.document_id === rows1[0]?.id, JSON.stringify(d1))
    renewalPointer = rows1[0]?.drive_file_id ?? ""
    renewalDocId = rows1[0]?.id ?? ""
    if (rows1[0]) { const st = await portalOpen(rows1[0].id); check("R4 the client opens the receipt (200)", st === 200, "HTTP " + st) }
    const { data: dl } = await sb.from("deadlines").select("deadline_record").eq("account_id", UX).eq("year", 2031).eq("deadline_type", "RA Renewal").maybeSingle()
    console.log("      (info) deadlines row for 2031: " + JSON.stringify(dl))
    await resetAccount() // the first filing rolled the date; put the cycle back so the retry targets the same year
    const r2 = await mk()
    const rows2 = await docsByName("RA Renewal 2031%")
    check("R5 filing again succeeds, makes no second row (same pointer, new version)", r2.status === 200 && rows2.length === 1 && rows2[0].drive_file_id === renewalPointer, "HTTP " + r2.status + " rows=" + rows2.length + " " + r2.text.slice(0, 200))
  } finally {
    await sb.from("accounts").update({ ra_renewal_date: acctBefore.ra_renewal_date, annual_report_due_date: acctBefore.annual_report_due_date, notes: acctBefore.notes }).eq("id", UX)
  }

  // ───────────────────────── (2) signed offer contract ─────────────────────────
  const { processOfferSigned } = await import("../../../lib/offers/process-offer-signed")
  const offerToken = tok()
  const offerIns = await sb.from("offers").insert({
    token: offerToken, client_name: "QA Test Cutover Offer", client_email: "qa-test@example.test", account_id: UX, contact_id: UX_CONTACT,
    status: "signed", language: "en", services: [], contract_type: "annual", access_code: randomUUID(), currency: "USD",
  }).select("id").single()
  if (offerIns.error) { console.log("      fixture offer insert failed:", offerIns.error.message) } else {
    const offerId = offerIns.data.id as string
    const pdfPath = `${offerToken}/signed.pdf`
    await sb.storage.from("signed-contracts").upload(pdfPath, await realPdf("signed offer contract"), { contentType: "application/pdf", upsert: true })
    const cIns = await sb.from("contracts").insert({ offer_token: offerToken, client_name: "QA Test Cutover Offer", status: "signed", pdf_path: pdfPath, signed_at: new Date().toISOString() }).select("id").single()
    if (cIns.error) { console.log("      fixture contract insert failed:", cIns.error.message) } else {
      const o1 = await processOfferSigned(offerToken)
      const du1 = String((o1.body as { drive_upload?: string }).drive_upload ?? "")
      check("O1 processOfferSigned filed the contract in the new storage", o1.status === 200 && du1.startsWith("ok: store:"), `HTTP ${o1.status} drive_upload=${du1}`)
      const oRows = await docsByName("Contract - QA Test Cutover Offer%")
      check("O2 ONE 'store:' row 'Signed Contract', shown to the client", oRows.length === 1 && oRows[0].drive_file_id.startsWith("store:") && oRows[0].portal_visible === true && oRows[0].document_type_name === "Signed Contract", JSON.stringify(oRows))
      if (oRows[0]) check("O3 the client opens the signed contract (200)", (await portalOpen(oRows[0].id)) === 200, `HTTP ${await portalOpen(oRows[0].id)}`)
      const o1b = await processOfferSigned(offerToken)
      check("O4 a second run is short-circuited (Already pending), no second row", (o1b.body as { message?: string }).message === "Already pending" && (await docsByName("Contract - QA Test Cutover Offer%")).length === 1, JSON.stringify(o1b.body).slice(0, 160))
      // force the filing step to run AGAIN (rename the first activation's token — an update, nothing deleted)
      await sb.from("pending_activations").update({ offer_token: `${offerToken}-renamed` }).eq("offer_token", offerToken)
      const o2 = await processOfferSigned(offerToken)
      const oRows2 = await docsByName("Contract - QA Test Cutover Offer%")
      check("O5 filing the contract again = a new version of the same file, still one row", o2.status === 200 && oRows2.length === 1 && oRows2[0].drive_file_id === oRows[0]?.drive_file_id, `HTTP ${o2.status} ${String((o2.body as { drive_upload?: string }).drive_upload)} rows=${oRows2.length}`)
    }
    void offerId
  }

  // ───────────────────────── (3) confirmed tax workbook ─────────────────────────
  const { runAttestHandoff } = await import("../../../lib/tax/attest-handoff")
  const { data: yrRow } = await sb.from("bank_transactions").select("tax_year").eq("account_id", UX).limit(1).maybeSingle()
  const year = Number(yrRow?.tax_year ?? 2024)
  const wbName = "Uxio Test LLC - PnL + Balance Sheet"
  const wbFiles = async () => {
    const { data: files } = await sb.from("store_files").select("id, name, state, folder_id, owner_id, current_version_id").like("name", `${wbName} ${year}%`).eq("state", "live")
    return (files ?? []) as Array<{ id: string; name: string; state: string; folder_id: string; owner_id: string; current_version_id: string | null }>
  }
  const verCount = async (fileId: string) => ((await sb.from("store_file_versions").select("id").eq("file_id", fileId)).data ?? []).length
  const f0 = await wbFiles()
  const v0 = f0[0] ? await verCount(f0[0].id) : 0
  const logsBefore = ((await sb.from("action_log").select("id").eq("action_type", "financials_attest_handoff").eq("account_id", UX)).data ?? []).length
  await runAttestHandoff(UX, year)
  const f1 = await wbFiles()
  const logs = ((await sb.from("action_log").select("summary, details, created_at").eq("action_type", "financials_attest_handoff").eq("account_id", UX).order("created_at", { ascending: false }).limit(1)).data ?? [])
  const outcome = (logs[0]?.details as { outcome?: string } | undefined)?.outcome
  console.log(`      (info) handoff log: ${logs[0]?.summary} (log rows before ${logsBefore})`)
  const wb = f1.filter((f) => f.name.endsWith("(client-confirmed).xlsx"))
  check("T1 the confirmed workbook landed in the company storage (outcome archived)", outcome === "archived" && wb.length === 1, `outcome=${outcome} files=${JSON.stringify(wb)}`)
  if (wb[0]) {
    const { data: folder } = await sb.from("store_folders").select("name, parent_id, kind").eq("id", wb[0].folder_id).maybeSingle()
    const { data: parent } = await sb.from("store_folders").select("name, kind").eq("id", folder?.parent_id).maybeSingle()
    check("T2 it sits in 3. Tax › <year>", folder?.name === String(year) && /tax/i.test(`${parent?.name} ${parent?.kind}`), JSON.stringify({ folder, parent }))
    const { data: ver } = await sb.from("store_file_versions").select("*").eq("id", wb[0].current_version_id).maybeSingle()
    const fileRow = (await sb.from("store_files").select("*").eq("id", wb[0].id).single()).data
    console.log(`      (info) file row keys: ${Object.keys(fileRow).join(",")}`)
    const pub = fileRow.published ?? fileRow.is_published ?? fileRow.shared_with_client ?? "n/a"
    check("T3 internal: not published to the client", pub === false || pub === "n/a", `published-flag=${pub}`)
    const docRows = ((await sb.from("documents").select("id, portal_visible").eq("drive_file_id", `store:${wb[0].id}`)).data ?? []) as Array<{ id: string; portal_visible: boolean }>
    check("T4 no client-visible CRM row points at the workbook", docRows.every((d) => d.portal_visible !== true), JSON.stringify(docRows))
    void ver
    const vBefore = await verCount(wb[0].id)
    await runAttestHandoff(UX, year)
    const f2 = (await wbFiles()).filter((f) => f.name.endsWith("(client-confirmed).xlsx"))
    const vAfter = f2[0] ? await verCount(f2[0].id) : -1
    check("T5 re-run = one file, same id, one more version", f2.length === 1 && f2[0].id === wb[0].id && vAfter === vBefore + 1, `files=${f2.length} sameId=${f2[0]?.id === wb[0].id} versions ${vBefore}→${vAfter} (before first run: ${v0})`)
  }

  // ───────────────────────── (4) readers ─────────────────────────
  const { openDocument, DocumentUnavailableError } = await import("../../../lib/documents/open-document")
  // a pointer to a file we know exists: the renewal receipt
  if (renewalPointer) {
    const od = await openDocument(renewalPointer)
    check("D1 openDocument(store: pointer) returns the PDF bytes", od.source === "store" && isPdf(od.buffer) && /RA Renewal 2031/.test(od.fileName ?? ""), `source=${od.source} name=${od.fileName} bytes=${od.buffer.length}`)
  }
  const olderPath = `qa-cutover/t12-${Date.now()}-QA Test older.pdf`.replace(/ /g, "_")
  await sb.storage.from("onboarding-uploads").upload(olderPath, await realPdf("older storage"), { contentType: "application/pdf", upsert: true })
  const oldOpen = await openDocument(`storage:${olderPath}`)
  check("D2 openDocument(older storage: pointer) returns the bytes", oldOpen.source === "storage" && isPdf(oldOpen.buffer), `source=${oldOpen.source} bytes=${oldOpen.buffer.length}`)
  const expectUnavailable = async (label: string, ptr: string) => {
    try { await openDocument(ptr); return `${label}: opened (unexpected)` } catch (e) { return e instanceof DocumentUnavailableError ? "" : `${label}: wrong error ${e instanceof Error ? e.name + " " + e.message : String(e)}` }
  }
  const miss = [
    await expectUnavailable("missing store", "store:00000000-0000-4000-8000-000000000000"),
    await expectUnavailable("missing storage", "storage:qa-cutover/does-not-exist-t12.pdf"),
    await expectUnavailable("malformed store", "store:not-a-uuid"),
    await expectUnavailable("empty", ""),
  ].filter(Boolean)
  check("D3 missing / malformed / empty pointers all raise DocumentUnavailableError (clear message)", miss.length === 0, miss.join(" | ") || "all four unavailable")

  // signature PDF route
  if (renewalPointer) {
    const sigTok = tok()
    const sIns = await sb.from("signature_requests").insert({ token: sigTok, status: "draft", drive_file_id: renewalPointer, pdf_storage_path: `${sigTok}/none.pdf`, account_id: UX, contact_id: UX_CONTACT, document_name: "QA Test t12", created_by: "qa" }).select("id").single()
    if (sIns.error) console.log("      fixture signature_requests insert failed:", sIns.error.message)
    else {
      const g = await call(`/api/signature-request/${sigTok}/pdf`)
      check("S1 signature PDF route streams a store: pointer", g.status === 200 && isPdf(g.bytes), `HTTP ${g.status} ${g.text.slice(0, 80)}`)
      await sb.from("signature_requests").update({ drive_file_id: "store:00000000-0000-4000-8000-000000000000" }).eq("id", sIns.data.id)
      const g2 = await call(`/api/signature-request/${sigTok}/pdf`)
      check("S2 …and a missing store pointer is a clean 404, not a 500", g2.status === 404, `HTTP ${g2.status} ${g2.text.slice(0, 80)}`)
    }
  }

  // prior-return extractor: a filed return that sits in the new storage
  const { saveDocumentForAccount } = await import("../../../lib/crm-store/save-for-account")
  const fr = await saveDocumentForAccount({
    accountId: UX, name: "QA Test Form 1120 2024 filed.pdf", bytes: await realPdf("filed return"), mimeType: "application/pdf", folder: "tax", documentType: null,
    callerKey: "qa-t12-filed-return", portalVisible: false, row: { document_type_name: "Form 1120", category_name: "Tax", status: "processed" },
  })
  if (fr.route !== "store") console.log("      filed-return fixture did not route to store")
  else {
    const { locateAndExtractOurFiledReturn } = await import("../../../lib/tax/prior-return-extract")
    const seen: Array<{ label: string; head: string; len: number }> = []
    await locateAndExtractOurFiledReturn(UX, 2024, null, {
      maxCandidates: 50,
      extractImpl: (async (buf: Buffer, label: string) => { seen.push({ label, head: buf.subarray(0, 5).toString("utf8"), len: buf.length }); return { status: "failed" } }) as never,
    })
    const mine = seen.find((s) => s.label === `drive:${fr.pointer}`)
    check("P1 prior-return extractor opens a store: pointer (bytes reach the extractor as a PDF)", !!mine && mine.head === "%PDF-", `candidates=${seen.length} mine=${JSON.stringify(mine)}`)
    check("P2 that filed return is internal (client gets 404 by id)", (await portalOpen(fr.documentRowId)) === 404, `HTTP ${await portalOpen(fr.documentRowId)}`)
  }

  // email attachments
  if (renewalPointer) {
    const { sendEmail } = await import("../../../lib/operations/email")
    const subj = `QA Test t12 attachment ${Date.now()}`
    const em = await sendEmail({ to: "qa-test@example.test", subject: subj, body_html: "<p>QA Test t12</p>", drive_file_ids: [renewalPointer], track_opens: false, skip_duplicate_check: true })
    check("E1 sendEmail attaches a store: pointer (sandbox: blocked at Gmail, attachment read)", em.has_attachments === true && em.attachment_count === 1 && /RA Renewal 2031/.test((em.attachment_filenames ?? []).join(",")), JSON.stringify(em).slice(0, 300))
    const em2 = await sendEmail({ to: "qa-test@example.test", subject: `${subj} b`, body_html: "<p>QA Test t12</p>", drive_file_ids: ["store:00000000-0000-4000-8000-000000000000"], track_opens: false, skip_duplicate_check: true })
    check("E2 a missing store pointer fails the send with a clear error (no half-sent mail)", em2.success === false && /no longer exists|unavailable|not found|readable/i.test(em2.error ?? ""), JSON.stringify(em2).slice(0, 300))
  }
  void renewalDocId
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
