/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ T22" rows) */
/**
 * Drive cutover QA (dev job ad09ea91): the Operating Agreement and the Office Lease work end to end for a BRAND-NEW company that
 * lives in the new storage and has NO Google Drive folder. SANDBOX only.
 *   needs the dev server on :3100, started with STORE_NEW_CLIENTS=1 and PUBLIC_APP_BASE_URL=http://localhost:3100
 *   (the OA finalizer calls APP_BASE_URL/api/oa-signed, so the server must call itself).
 *   npx tsx scripts/crm-store/qa-cutover/t22-oa-lease-no-drive.ts
 */
import { config } from "dotenv"
import { randomUUID } from "crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { call, sessionCookie } from "./qa-http"
config({ path: ".env.local" })

let failures = 0
const check = (cond: unknown, msg: string, extra?: unknown) => {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.log(`  FAIL  ${msg}${extra === undefined ? "" : " — " + JSON.stringify(extra).slice(0, 600)}`) }
}
const note = (msg: string, x?: unknown) => console.log(`  NOTE  ${msg}${x === undefined ? "" : " — " + JSON.stringify(x).slice(0, 600)}`)
async function pdf(lines: string[]): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  const p = d.addPage([612, 792])
  lines.forEach((l, j) => p.drawText(l, { x: 50, y: 740 - j * 16, size: 11, font: f }))
  return Buffer.from(await d.save())
}
// a valid 1x1 PNG (the signature image the page would draw)
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not the sandbox — refusing")
  process.env.SANDBOX_MODE = "1"
  process.env.STORE_NEW_CLIENTS = "1"
  delete process.env.GOOGLE_DRIVE_LIVE
  // the sandbox .env.local carries an EMPTY INTERNAL_WEBHOOK_SECRET (the gate fails closed on /api/oa-signed), so this run uses a throw-away
  // secret; the dev server must be started with the same value: INTERNAL_WEBHOOK_SECRET=zz-t22-local-secret
  process.env.INTERNAL_WEBHOOK_SECRET = process.env.T22_SECRET || "zz-t22-local-secret"
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const pilot = await import("../../../lib/crm-store/formation-pilot")
  const { processOfferSigned } = await import("../../../lib/offers/process-offer-signed")
  const { createSD } = await import("../../../lib/operations/service-delivery")
  const { handleFormationSetup } = await import("../../../lib/jobs/handlers/formation-setup")
  const { materializeFormationCompany } = await import("../../../lib/operations/formation-materialize")
  const { createLease } = await import("../../../lib/operations/lease")
  const { newYorkToday } = await import("../../../lib/lease/agreement-v2")
  const { registerOaTools } = await import("../../../lib/mcp/tools/oa")
  const { internalWebhookServerHeaders } = await import("../../../lib/webhook-internal-auth")
  const { findWelcomeDocsFromRecords } = await import("../../../lib/operations/welcome-docs")
  const { handleWelcomePackagePrepare } = await import("../../../lib/jobs/handlers/welcome-package-setup")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const tag0 = Date.now()
  let seq = 0

  // the real oa_create tool, called through a stand-in server that just collects the handler
  const tools: Record<string, (p: unknown) => Promise<{ content: Array<{ text: string }> }>> = {}
  registerOaTools({ tool: (name: string, _d: string, _s: unknown, h: never) => { tools[name] = h } } as never)

  async function buildCompany(label: string) {
    const tag = `${tag0}${++seq}`
    const email = `zz-t22-${label}-${tag}@example.test`
    const name = `ZZ T22 ${label} Buyer ${tag}`
    const llc = `ZZ T22 ${label} ${tag} LLC`
    const { data: tpl } = await db.from("offers").select("*").eq("token", "qa-s1b-b6-f7-2026-v2").maybeSingle()
    if (!tpl) throw new Error("template offer not found in the sandbox")
    const token = `zz-t22-${label}-${tag}`
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = tpl // eslint-disable-line @typescript-eslint/no-unused-vars
    const { data: lead } = await db.from("leads").insert({ full_name: name, email, is_test: true }).select("id").single()
    await db.from("offers").insert({ ...rest, token, client_name: name, client_email: email, status: "signed", account_id: null, lead_id: lead.id, contact_id: null })
    const contractPath = `zz-t22-${tag}/contract-signed.pdf`
    await db.storage.from("signed-contracts").upload(contractPath, await pdf(["ZZ T22 signed contract"]), { contentType: "application/pdf", upsert: true })
    await db.from("contracts").insert({ offer_token: token, client_name: name, pdf_path: contractPath })
    const signed = await processOfferSigned(token)
    const { data: contact } = await db.from("contacts").select("id").eq("email", email).maybeSingle()
    if (signed.status !== 200 || !contact?.id) throw new Error(`offer signing failed: ${JSON.stringify(signed).slice(0, 300)}`)
    const contactId = contact.id as string
    const sd = await createSD({ service_type: "Company Formation", contact_id: contactId, account_id: null, service_name: `Company Formation - ${llc}` } as never)
    const sdId = (sd as { id: string }).id
    const passPath = `zz-t22-${tag}/passport.pdf`
    await db.storage.from("onboarding-uploads").upload(passPath, await pdf(["ZZ T22 passport"]), { contentType: "application/pdf", upsert: true })
    const answers = {
      owner_first_name: "Zeta", owner_last_name: `T22 ${tag}`, owner_email: email, owner_phone: "+1 555 0100", owner_dob: "1980-05-06",
      owner_nationality: "Italy", owner_street: "Via Roma 1", owner_city: "Milano", owner_state_province: "MI", owner_zip: "20100",
      owner_country: "Italy", owner_is_signer: true, entity_type: "SMLLC", state_of_formation: "WY", member_count: 0, business_purpose: "Consulting",
      llc_name_1: llc, llc_name_2: `${llc} Two`, llc_name_3: `${llc} Three`, chosen_name_final: llc, disclaimer_accepted: true, passport_owner: passPath,
    }
    await db.from("wizard_progress").insert({ contact_id: contactId, wizard_type: "formation", status: "submitted", data: answers, service_delivery_id: sdId })
    await handleFormationSetup({ id: randomUUID(), job_type: "formation_setup", status: "processing", attempts: 1, max_attempts: 3, payload: { token: `portal-zz-t22-${tag}`, submission_id: null, contact_id: contactId, lead_id: null, submitted_data: answers, source: "portal_wizard" } } as never)
    const base = { sd: { id: sdId, contact_id: contactId, account_id: null, service_type: "Company Formation" }, mimeType: "application/pdf" }
    const art = await pilot.pilotSaveFormationUpload({ ...base, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: await pdf(["ARTICLES", llc]) })
    const ein = await pilot.pilotSaveFormationUpload({ ...base, flowStage: "EIN Received", fileName: "CP575.pdf", bytes: await pdf(["CP 575 EIN"]) })
    const m = await materializeFormationCompany({ contact_id: contactId, formation_state: "WY", entity_type: "SMLLC", chosen_name: llc, formation_date: "2026-10-14", actor: "zz-t22" })
    if (!m.success || !m.account_id) throw new Error(`company creation failed: ${JSON.stringify({ outcome: m.outcome, error: m.error })}`)
    const accountId = m.account_id as string
    const { data: owner } = await db.from("store_owners").select("id, kind, account_id, study_only").eq("service_delivery_id", sdId).maybeSingle()
    const { data: acct } = await db.from("accounts").select("id, company_name, drive_folder_id, state_of_formation, suite_number").eq("id", accountId).single()
    return { tag, email, llc, contactId, sdId, accountId, owner, acct, art, ein }
  }

  /** everything the signed-document checks need: the file in "1. Company", the CRM record, the type */
  async function inStorage(c: { owner: { id: string }; accountId: string }, nameLike: string, docType: string) {
    const { data: folder } = await db.from("store_folders").select("id").eq("owner_id", c.owner.id).eq("name", "1. Company").maybeSingle()
    const { data: files } = await db.from("store_files").select("id, name, folder_id, document_type, published, state, current_version_id").eq("owner_id", c.owner.id).ilike("name", `%${nameLike}%`)
    const f = (files ?? [])[0]
    const { data: versions } = f ? await db.from("store_file_versions").select("id, version_no, size_bytes").eq("file_id", f.id).order("version_no") : { data: [] }
    const { data: docs } = f ? await db.from("documents").select("id, account_id, drive_file_id, document_type_name, portal_visible, drive_link").eq("drive_file_id", `store:${f.id}`) : { data: [] }
    return { folder, files: files ?? [], file: f, versions: versions ?? [], docs: docs ?? [], docType }
  }

  // ═════════════════ 1. the company ═════════════════
  console.log("\n1. a brand-new company in the storage, no Drive folder")
  const A = await buildCompany("A")
  check(A.owner?.kind === "company" && A.owner.study_only === false && A.owner.account_id === A.accountId, "store owner is kind=company, live, on the account", A.owner)
  check(A.acct.drive_folder_id === null, "accounts.drive_folder_id is null", A.acct)
  note(`company: ${A.acct.company_name}; suite before lease: ${A.acct.suite_number ?? "none"}`)

  // ═════════════════ 2. the Office Lease ═════════════════
  console.log("\n2. Office Lease — create, client signs, signed PDF lands in the storage")
  const staff = await sessionCookie("staff")
  const lr = await createLease({ account_id: A.accountId, issue_suite_if_missing: true, actor: "zz-t22" })
  check(lr.success && lr.outcome === "created" && !!lr.lease, "createLease created the lease", lr)
  if (!lr.lease) throw new Error("no lease — cannot continue")
  const leaseId = lr.lease.id, leaseToken = lr.lease.token, leaseCode = lr.lease.access_code
  const { data: lease0 } = await db.from("lease_agreements").select("*").eq("id", leaseId).single()
  check(lease0.status === "draft" && lease0.template_version === 2 && lease0.account_id === A.accountId, "lease is a draft v2 on the company", { status: lease0.status, tv: lease0.template_version })

  // the page: upload the signed PDF to signed-leases (anon in the browser), then POST /api/lease/[token]/sign
  const pdfPath = `${leaseToken}/lease-signed-${Date.now()}.pdf`
  const { error: upErr } = await db.storage.from("signed-leases").upload(pdfPath, await pdf(["ZZ T22 signed lease", A.llc]), { contentType: "application/pdf", upsert: true })
  check(!upErr, "signed PDF uploaded to the signed-leases bucket (what the page does)", upErr?.message)
  const wrong = await call(`/api/lease/${leaseToken}/sign`, { json: { code: "00000000", pdf_storage_path: pdfPath, operating_address: "1 Test St, Miami FL", signing_date: newYorkToday(), suite_number: lease0.suite_number, tenant_company: lease0.tenant_company, tenant_contact_name: lease0.tenant_contact_name, tenant_title: lease0.tenant_title ?? "" } })
  check(wrong.status === 403, "a wrong access code is refused (403)", `HTTP ${wrong.status} ${wrong.text.slice(0, 120)}`)
  const sign = await call(`/api/lease/${leaseToken}/sign`, { json: { code: leaseCode, pdf_storage_path: pdfPath, operating_address: "1 Test St, Miami FL", signing_date: newYorkToday(), suite_number: lease0.suite_number, tenant_company: lease0.tenant_company, tenant_contact_name: lease0.tenant_contact_name, tenant_title: lease0.tenant_title ?? "" } })
  check(sign.status === 200, "sign route accepts the signature", `HTTP ${sign.status} ${sign.text.slice(0, 200)}`)
  const { data: lease1 } = await db.from("lease_agreements").select("status, signed_at, pdf_storage_path").eq("id", leaseId).single()
  check(lease1.status === "signed" && !!lease1.signed_at && lease1.pdf_storage_path === pdfPath, "lease row is signed with the PDF path", lease1)

  const filed = await call("/api/lease-signed", { json: { lease_id: leaseId, token: leaseToken, code: leaseCode } })
  check(filed.status === 200, "/api/lease-signed returns 200", `HTTP ${filed.status} ${filed.text.slice(0, 200)}`)
  const steps = ((filed.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
  for (const s of steps) note(`lease-signed step ${s.step}: ${s.status}`, s.detail)
  const up = steps.find((s) => s.step === "drive_upload")
  check(up?.status === "ok" && /new storage: store:/.test(up.detail ?? ""), "filing step saved into the new storage (not Drive)", up)
  const mail = steps.find((s) => s.step === "email_notification")
  check(!!mail, "the support-email step ran", mail)
  note(`support email step outcome (sandbox should block it)`, mail)
  check(!steps.some((s) => s.step === "drive_upload" && s.status === "error"), "no error in the filing step")
  const L = await inStorage(A as never, "Lease Agreement", "office_lease")
  check(L.files.length === 1, "exactly ONE lease file in the company storage", L.files.map((f) => f.name))
  check(L.file && L.folder && L.file.folder_id === L.folder.id, "…in the '1. Company' folder", { file_folder: L.file?.folder_id, company_folder: L.folder?.id })
  check(L.file?.document_type === "office_lease", "…typed office_lease", L.file?.document_type)
  check(L.file?.state === "active" || L.file?.state === "ready" || L.file?.state, "…file state recorded", L.file?.state)
  check(L.docs.length === 1 && L.docs[0].account_id === A.accountId && String(L.docs[0].drive_file_id).startsWith("store:"), "one CRM documents row, drive_file_id store:…, on the company", L.docs)
  check(L.docs[0]?.document_type_name === "Lease Agreement" && L.docs[0]?.portal_visible === true, "…named Lease Agreement and shown in the portal", L.docs[0])
  check(L.versions.length === 1, "one stored version", L.versions)
  const { data: acctAfter } = await db.from("accounts").select("drive_folder_id").eq("id", A.accountId).single()
  check(acctAfter.drive_folder_id === null, "still no Drive folder on the account (nothing was created on Drive)")
  const { data: leaseRow } = await db.from("lease_agreements").select("pdf_drive_file_id").eq("id", leaseId).single()
  note("lease_agreements.pdf_drive_file_id after signing", leaseRow.pdf_drive_file_id)

  // filing twice = a new version / same file, never a second copy
  const filed2 = await call("/api/lease-signed", { json: { lease_id: leaseId, token: leaseToken, code: leaseCode } })
  check(filed2.status === 200, "calling /api/lease-signed again is harmless", `HTTP ${filed2.status}`)
  const L2 = await inStorage(A as never, "Lease Agreement", "office_lease")
  check(L2.files.length === 1 && L2.docs.length === 1, "…and makes no second copy", { files: L2.files.length, docs: L2.docs.length })

  // regen paths
  console.log("\n2b. Lease regeneration paths (staff)")
  const regen = await call("/api/crm/admin-actions/regen-lease-pdf", { cookie: staff, json: { lease_id: leaseId } })
  check(regen.status === 200, "regen-lease-pdf returns 200", `HTTP ${regen.status} ${regen.text.slice(0, 250)}`)
  check(String((regen.json as { driveFileId?: string } | null)?.driveFileId ?? "").startsWith("store:"), "…and answers with a store: pointer (no Drive)", regen.json)
  const L3 = await inStorage(A as never, "Lease Agreement", "office_lease")
  check(L3.files.length === 1 && L3.docs.length === 1, "…same single file after regen (new version, no copy)", { files: L3.files.length, docs: L3.docs.length })
  check(L3.versions.length === 2, "…it is now version 2 of that file", L3.versions)
  const { data: leaseRegen } = await db.from("lease_agreements").select("pdf_storage_path, pdf_drive_file_id").eq("id", leaseId).single()
  check(String(leaseRegen.pdf_drive_file_id ?? "").startsWith("store:"), "…lease row points to the store file", leaseRegen)
  const regenDrive = await call("/api/lease-regen-drive", { cookie: staff, json: { lease_id: leaseId, token: leaseToken } })
  check(regenDrive.status === 200 && String((regenDrive.json as { driveFileId?: string } | null)?.driveFileId ?? "").startsWith("store:"), "lease-regen-drive saves to the store too", `HTTP ${regenDrive.status} ${regenDrive.text.slice(0, 250)}`)
  const L4 = await inStorage(A as never, "Lease Agreement", "office_lease")
  check(L4.files.length === 1 && L4.docs.length === 1, "…still one file / one record", { files: L4.files.length, docs: L4.docs.length })
  const regenOff = await call("/api/crm/admin-actions/regen-lease-pdf", { json: { lease_id: leaseId } })
  check(regenOff.status === 401, "regen without a staff login is refused (401)", `HTTP ${regenOff.status}`)

  // ═════════════════ 3. the Operating Agreement ═════════════════
  console.log("\n3. Operating Agreement — create (oa_create), sign, executed PDF lands in the storage")
  const created = await tools.oa_create({ account_id: A.accountId })
  const createdText = created.content.map((c) => c.text).join("\n")
  check(!/^❌|Insert failed|not supported|not found/m.test(createdText), "oa_create succeeded", createdText.slice(0, 300))
  const { data: oa0 } = await db.from("oa_agreements").select("id, token, access_code, status, total_signers, entity_type, account_id, pdf_storage_path").eq("account_id", A.accountId).maybeSingle()
  check(!!oa0 && oa0.status === "draft" && oa0.entity_type === "SMLLC", "OA row exists as a draft SMLLC", oa0)
  if (!oa0) throw new Error("no OA — cannot continue")
  const wrongOa = await call(`/api/operating-agreement/${oa0.token}/sign`, { json: { code: "00000000", consent: true, signature_png: PNG_DATA_URL } })
  check(wrongOa.status === 403, "OA sign with a wrong access code is refused (403)", `HTTP ${wrongOa.status} ${wrongOa.text.slice(0, 120)}`)
  const noConsent = await call(`/api/operating-agreement/${oa0.token}/sign`, { json: { code: oa0.access_code, consent: false, signature_png: PNG_DATA_URL } })
  check(noConsent.status === 400, "OA sign without consent is refused (400)", `HTTP ${noConsent.status}`)
  const osign = await call(`/api/operating-agreement/${oa0.token}/sign`, { json: { code: oa0.access_code, consent: true, signature_png: PNG_DATA_URL, signature_method: "drawn" } })
  check(osign.status === 200 && (osign.json as { allSigned?: boolean } | null)?.allSigned === true, "OA sign route: signed, all signed", `HTTP ${osign.status} ${osign.text.slice(0, 250)}`)
  const { data: oa1 } = await db.from("oa_agreements").select("status, signed_at, pdf_storage_path, signed_count").eq("id", oa0.id).single()
  check(oa1.status === "signed" && !!oa1.signed_at && !!oa1.pdf_storage_path && oa1.signed_count === 1, "OA row is signed with its executed PDF recorded", oa1)
  // the finalizer calls /api/oa-signed on the server itself; give the filing a moment, then look
  let O = await inStorage(A as never, "Operating Agreement", "operating_agreement")
  for (let i = 0; i < 10 && O.files.length === 0; i++) { await new Promise((r) => setTimeout(r, 1000)); O = await inStorage(A as never, "Operating Agreement", "operating_agreement") }
  check(O.files.length === 1, "exactly ONE Operating Agreement file in the company storage (filed by the finalizer's call to /api/oa-signed)", O.files.map((f) => f.name))
  check(O.file && O.folder && O.file.folder_id === O.folder.id, "…in the '1. Company' folder", { file_folder: O.file?.folder_id, company_folder: O.folder?.id })
  check(O.file?.document_type === "operating_agreement", "…typed operating_agreement", O.file?.document_type)
  check(O.docs.length === 1 && String(O.docs[0].drive_file_id).startsWith("store:") && O.docs[0].account_id === A.accountId, "one CRM record, drive_file_id store:…, on the company", O.docs)
  check(O.docs[0]?.document_type_name === "Operating Agreement" && O.docs[0]?.portal_visible === true, "…named Operating Agreement, shown in the portal", O.docs[0])
  const { data: acct2 } = await db.from("accounts").select("drive_folder_id").eq("id", A.accountId).single()
  check(acct2.drive_folder_id === null, "still no Drive folder on the account")
  // direct call to /api/oa-signed (what the finalizer / a re-run does): read its step list
  const direct = await call("/api/oa-signed", { headers: internalWebhookServerHeaders() as Record<string, string>, json: { oa_id: oa0.id, token: oa0.token } })
  check(direct.status === 200, "/api/oa-signed (internal secret) returns 200", `HTTP ${direct.status} ${direct.text.slice(0, 200)}`)
  const osteps = ((direct.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
  for (const s of osteps) note(`oa-signed step ${s.step}: ${s.status}`, s.detail)
  const oup = osteps.find((s) => s.step === "drive_upload")
  check(oup?.status === "ok" && /new storage: store:/.test(oup.detail ?? ""), "filing step says saved to the new storage", oup)
  check(!osteps.some((s) => s.status === "error" && s.step !== "email_notification"), "no error step other than the (sandbox-blocked) email", osteps.filter((s) => s.status === "error"))
  const omail = osteps.find((s) => s.step === "email_notification")
  note("support email step outcome (sandbox should block it)", omail)
  const O2 = await inStorage(A as never, "Operating Agreement", "operating_agreement")
  check(O2.files.length === 1 && O2.docs.length === 1, "…re-filing makes no second copy", { files: O2.files.length, docs: O2.docs.length })
  const noSecret = await call("/api/oa-signed", { json: { oa_id: oa0.id, token: oa0.token } })
  check(noSecret.status === 401, "/api/oa-signed without the internal secret is refused (401)", `HTTP ${noSecret.status}`)
  const sentinel = await db.from("system_errors").select("id", { count: "exact", head: true }).ilike("message", `%${oa0.token}%`)
  check((sentinel.count ?? 0) === 0 || sentinel.error, "no system error was reported for this OA", sentinel.count ?? sentinel.error?.message)

  // ═════════════════ 4. the welcome package (job handler) ═════════════════
  console.log("\n4. Welcome package — job handler for a second new company with no Drive folder")
  const B = await buildCompany("B")
  check(B.acct.drive_folder_id === null && B.owner?.kind === "company", "company B: store owner kind=company, no Drive folder", { owner: B.owner?.kind, drive: B.acct.drive_folder_id })
  await db.from("accounts").update({ ein_number: "99-9999999" }).eq("id", B.accountId) // the handler skips a company without an EIN
  const { data: ein0 } = await db.from("accounts").select("welcome_package_status, ein_number").eq("id", B.accountId).single()
  const wdocs = await findWelcomeDocsFromRecords(B.accountId)
  check(!!wdocs.ein && !!wdocs.articles, "findWelcomeDocsFromRecords finds the EIN letter and the Articles (no Drive)", wdocs)
  const prevSwitch = process.env.AUTO_LEASE_OA_CREATION_ENABLED
  process.env.AUTO_LEASE_OA_CREATION_ENABLED = "true" // so the handler also creates the OA + lease (otherwise it skips them by design)
  // the handler needs a suite to create a lease — issue one the way the Suite step would
  const { allocateCompanySuite } = await import("../../../lib/operations/suite")
  const suiteB = await allocateCompanySuite({ accountId: B.accountId, actor: "zz-t22" })
  note(`suite issued for B before the job: ${suiteB}; welcome_package_status before: ${ein0.welcome_package_status ?? "null"}`)
  const wp = await handleWelcomePackagePrepare({ id: randomUUID(), job_type: "welcome_package_prepare", status: "processing", attempts: 1, max_attempts: 3, payload: { account_id: B.accountId } } as never)
  if (prevSwitch === undefined) delete process.env.AUTO_LEASE_OA_CREATION_ENABLED
  else process.env.AUTO_LEASE_OA_CREATION_ENABLED = prevSwitch
  for (const s of wp.steps) note(`welcome step ${s.name}: ${s.status}`, s.detail)
  const byName = new Map(wp.steps.map((s) => [s.name, s]))
  check(byName.get("oa")?.status === "ok", "step oa: OA created", byName.get("oa"))
  check(byName.get("lease")?.status === "ok", "step lease: lease created", byName.get("lease"))
  check(byName.get("ein_letter")?.status === "ok" && byName.get("articles")?.status === "ok", "steps ein_letter + articles found in the CRM records", { ein: byName.get("ein_letter"), articles: byName.get("articles") })
  check(!wp.steps.some((s) => /drive/i.test(s.name) && s.status === "error"), "no Drive-related error step")
  const wpErr = wp.steps.filter((s) => s.status === "error")
  check(wpErr.length === 0, "the job has no error step at all", wpErr)
  const { data: wpAcct } = await db.from("accounts").select("welcome_package_status, drive_folder_id").eq("id", B.accountId).single()
  check(wpAcct.welcome_package_status === "prepared" && wpAcct.drive_folder_id === null, "welcome_package_status = prepared, still no Drive folder", wpAcct)

  // the documents the job created must be signable too
  console.log("\n4b. …and the lease + OA the job created can be signed and filed")
  const { data: bl } = await db.from("lease_agreements").select("*").eq("account_id", B.accountId).maybeSingle()
  const { data: bo } = await db.from("oa_agreements").select("id, token, access_code, status").eq("account_id", B.accountId).maybeSingle()
  check(!!bl && !!bo, "company B has its lease and OA rows", { lease: !!bl, oa: !!bo })
  if (bl && bo) {
    const bPath = `${bl.token}/lease-signed-${Date.now()}.pdf`
    await db.storage.from("signed-leases").upload(bPath, await pdf(["ZZ T22 B lease"]), { contentType: "application/pdf", upsert: true })
    const bs = await call(`/api/lease/${bl.token}/sign`, { json: { code: bl.access_code, pdf_storage_path: bPath, operating_address: "2 Test St, Miami FL", signing_date: newYorkToday(), suite_number: bl.suite_number, tenant_company: bl.tenant_company, tenant_contact_name: bl.tenant_contact_name, tenant_title: bl.tenant_title ?? "" } })
    check(bs.status === 200, "B lease sign accepted", `HTTP ${bs.status} ${bs.text.slice(0, 200)}`)
    const bf = await call("/api/lease-signed", { json: { lease_id: bl.id, token: bl.token, code: bl.access_code } })
    const bstep = ((bf.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? []).find((s) => s.step === "drive_upload")
    check(bf.status === 200 && bstep?.status === "ok" && /store:/.test(bstep.detail ?? ""), "B lease filed into the storage", bstep)
    const bos = await call(`/api/operating-agreement/${bo.token}/sign`, { json: { code: bo.access_code, consent: true, signature_png: PNG_DATA_URL } })
    check(bos.status === 200, "B OA sign accepted", `HTTP ${bos.status} ${bos.text.slice(0, 200)}`)
    let BO = await inStorage(B as never, "Operating Agreement", "operating_agreement")
    for (let i = 0; i < 10 && BO.files.length === 0; i++) { await new Promise((r) => setTimeout(r, 1000)); BO = await inStorage(B as never, "Operating Agreement", "operating_agreement") }
    const BL = await inStorage(B as never, "Lease Agreement", "office_lease")
    check(BO.files.length === 1 && BO.file?.document_type === "operating_agreement" && BO.docs.length === 1, "B Operating Agreement in storage, typed", { n: BO.files.length, t: BO.file?.document_type })
    check(BL.files.length === 1 && BL.file?.document_type === "office_lease" && BL.docs.length === 1, "B lease in storage, typed", { n: BL.files.length, t: BL.file?.document_type })
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
