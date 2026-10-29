/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ B18" rows) */
/**
 * Formation upload keeps the PICKED document type (Luca / Redstone Atlas EIN, 2026-10-29) — the t18 new-client run with the EIN box picking LTR 147C. A NEW client lives in the new storage from the start.
 * SANDBOX only. Runs the REAL code with STORE_NEW_CLIENTS=1 and a buyer who is NOT on the pilot list:
 *   sign (contract in the person's storage) → payment (formation storage opens) → wizard submit → Articles / signed SS-4 / EIN
 *   uploads → company creation (handover). Nothing goes to Drive.
 *   npx tsx scripts/crm-store/qa-cutover/t53-formation-upload-chosen-type.ts
 */
import { config } from "dotenv"
import { randomUUID } from "crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
config({ path: ".env.local" })

let failures = 0
function check(cond: unknown, msg: string, extra?: unknown) {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.log(`  FAIL  ${msg}`, extra === undefined ? "" : JSON.stringify(extra)) }
}
async function pdf(lines: string[]): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  const p = d.addPage([612, 792])
  lines.forEach((l, j) => p.drawText(l, { x: 50, y: 740 - j * 16, size: 11, font: f }))
  return Buffer.from(await d.save())
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not the sandbox — refusing")
  process.env.SANDBOX_MODE = "1"
  process.env.STORE_NEW_CLIENTS = "1"
  delete process.env.GOOGLE_DRIVE_LIVE
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const pilot = await import("../../../lib/crm-store/formation-pilot")
  const { processOfferSigned } = await import("../../../lib/offers/process-offer-signed")
  const { createSD } = await import("../../../lib/operations/service-delivery")
  const { handleFormationSetup } = await import("../../../lib/jobs/handlers/formation-setup")
  const { materializeFormationCompany } = await import("../../../lib/operations/formation-materialize")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const tag = Date.now()
  const email = `zz-b18-${tag}@example.test`
  const name = `ZZ B18 Buyer ${tag}`
  const llc = `ZZ B18 ${tag} LLC`

  console.log("\n0. the switch")
  check(pilot.newClientsLive(), "new clients are ON for this run")
  const { data: setRow } = await db.from("app_settings").select("value").eq("key", pilot.PILOT_SETTINGS_KEY).maybeSingle()
  check(!JSON.stringify(setRow?.value ?? {}).includes(email), "the buyer is NOT on the pilot list (the switch alone decides)")

  console.log("\n1. the lead signs the contract")
  const { data: tpl } = await db.from("offers").select("*").eq("token", "qa-s1b-b6-f7-2026-v2").maybeSingle()
  if (!tpl) throw new Error("template offer not found in the sandbox")
  const token = `zz-b18-${tag}`
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = tpl // eslint-disable-line @typescript-eslint/no-unused-vars
  const { data: lead, error: lErr } = await db.from("leads").insert({ full_name: name, email, is_test: true }).select("id").single()
  if (lErr) throw new Error(`lead: ${lErr.message}`)
  const { error: oErr } = await db.from("offers").insert({ ...rest, token, client_name: name, client_email: email, status: "signed", account_id: null, lead_id: lead.id, contact_id: null })
  if (oErr) throw new Error(`offer: ${oErr.message}`)
  const contractPath = `zz-b18-${tag}/contract-signed.pdf`
  await db.storage.from("signed-contracts").upload(contractPath, await pdf(["ZZ B18 signed contract"]), { contentType: "application/pdf", upsert: true })
  await db.from("contracts").insert({ offer_token: token, client_name: name, pdf_path: contractPath })
  const signed = await processOfferSigned(token)
  check(signed.status === 200, "signing processed", signed)
  const { data: contact } = await db.from("contacts").select("id").eq("email", email).maybeSingle()
  check(!!contact?.id, "the lead became a contact")
  const contactId = contact.id as string
  const { data: pOwner } = await db.from("store_owners").select("id, kind, study_only").eq("contact_id", contactId).eq("kind", "person").maybeSingle()
  check(pOwner && pOwner.study_only === false, "the contact has its own LIVE storage", pOwner)
  const { data: cFiles } = await db.from("store_files").select("id, name, document_type, published").eq("owner_id", pOwner?.id)
  check((cFiles ?? []).length === 1 && /Signed/.test(cFiles[0].name), "the signed contract is in it", cFiles)
  check(cFiles?.[0]?.published === false, "…hidden from the client")
  const { data: cDocs } = await db.from("documents").select("id, contact_id, account_id, portal_visible, drive_file_id").eq("drive_file_id", `store:${cFiles?.[0]?.id}`)
  check((cDocs ?? []).length === 1 && cDocs[0].contact_id === contactId && cDocs[0].account_id === null && cDocs[0].portal_visible === false, "one CRM record for it, on the contact", cDocs)
  check(String(signed.body.drive_upload).startsWith("ok: store:"), "nothing went to Drive", signed.body.drive_upload)
  const again = await processOfferSigned(token)
  check(again.status === 200, "signing twice is harmless")
  check(((await db.from("store_files").select("id").eq("owner_id", pOwner.id)).data ?? []).length === 1, "…and makes no second copy")

  console.log("\n2. payment — the formation case is created")
  const sd = await createSD({ service_type: "Company Formation", contact_id: contactId, account_id: null, service_name: `Company Formation - ${llc}` } as never)
  const sdId = (sd as { id: string }).id
  const { data: fOwner } = await db.from("store_owners").select("id, kind").eq("service_delivery_id", sdId).maybeSingle()
  check(fOwner?.kind === "formation", "the company-in-formation storage exists at once", fOwner)
  const { data: folders } = await db.from("store_folders").select("name, parent_id").eq("owner_id", fOwner?.id)
  check(folders.filter((f: { parent_id: string | null }) => f.parent_id).map((f: { name: string }) => f.name).sort().join("|") === "1. Company|2. Contacts|3. Tax|4. Banking|5. Correspondence", "with the five folders", folders)

  console.log("\n3. the wizard is submitted")
  const passPath = `zz-b18-${tag}/passport.pdf`
  await db.storage.from("onboarding-uploads").upload(passPath, await pdf(["ZZ B18 passport"]), { contentType: "application/pdf", upsert: true })
  const answers = {
    owner_first_name: "Zeta", owner_last_name: `B18 ${tag}`, owner_email: email, owner_phone: "+1 555 0100", owner_dob: "1980-05-06",
    owner_nationality: "Italy", owner_street: "Via Roma 1", owner_city: "Milano", owner_state_province: "MI", owner_zip: "20100",
    owner_country: "Italy", owner_is_signer: true, entity_type: "SMLLC", state_of_formation: "WY", member_count: 0, business_purpose: "Consulting",
    llc_name_1: llc, llc_name_2: `${llc} Two`, llc_name_3: `${llc} Three`, chosen_name_final: llc, disclaimer_accepted: true, passport_owner: passPath,
  }
  await db.from("wizard_progress").insert({ contact_id: contactId, wizard_type: "formation", status: "submitted", data: answers, service_delivery_id: sdId })
  const r = await handleFormationSetup({ id: randomUUID(), job_type: "formation_setup", status: "processing", attempts: 1, max_attempts: 3, payload: { token: `portal-zz-b18-${tag}`, submission_id: null, contact_id: contactId, lead_id: null, submitted_data: answers, source: "portal_wizard" } } as never)
  const steps = new Map(r.steps.map((s) => [s.name, s]))
  check(steps.get("store_passport")?.status === "ok", "passport saved in the buyer's storage", steps.get("store_passport"))
  check(steps.get("store_formation_summary")?.status === "ok", "Formation Summary saved in the company-in-formation", steps.get("store_formation_summary"))
  check(!steps.has("drive_folder"), "no Drive folder for the contact")

  console.log("\n4. workspace uploads: Articles, signed SS-4, EIN")
  const base = { sd: { id: sdId, contact_id: contactId, account_id: null, service_type: "Company Formation" }, mimeType: "application/pdf" }
  const art = await pilot.pilotSaveFormationUpload({ ...base, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: await pdf(["ARTICLES", llc]) })
  const ss4 = await pilot.pilotSaveFormationUpload({ ...base, flowStage: "SS-4 Signed", fileName: "SS4-fax.pdf", bytes: await pdf(["SS-4 fax confirmation"]) })
  const ein = await pilot.pilotSaveFormationUpload({ ...base, flowStage: "EIN Received", fileName: "LTR147C.pdf", bytes: await pdf(["LTR 147C EIN"]), documentType: "ein_irs_fax_ltr_147c" })
  check(art.status === "saved" && ss4.status === "saved" && ein.status === "saved", "all three saved in the new storage (none refused, none on Drive)", { art, ss4, ein })
  const types = (await db.from("store_files").select("document_type").eq("owner_id", fOwner.id)).data.map((x: { document_type: string }) => x.document_type).sort().join(",")
  check(types.includes("articles_of_organization") && types.includes("fax_confirmation") && types.includes("ein_irs_fax_ltr_147c") && !types.includes("ein_letter_irs"), "Articles / SS-4 fax typed by stage; the EIN letter keeps the PICKED type (LTR 147C), not the stage default", types)

  console.log("\n5. the Articles arrive — the company is created")
  const m = await materializeFormationCompany({ contact_id: contactId, formation_state: "WY", entity_type: "SMLLC", chosen_name: llc, formation_date: "2026-10-14", actor: "zz-b18" })
  check(m.success, "company created", { outcome: m.outcome, error: m.error })
  const { data: after } = await db.from("store_owners").select("id, kind, account_id").eq("service_delivery_id", sdId).maybeSingle()
  check(after?.kind === "company" && after.account_id === m.account_id && after.id === fOwner.id, "the SAME storage is now the company's", after)
  const { data: root } = await db.from("store_folders").select("name").eq("owner_id", fOwner.id).is("parent_id", null).single()
  check(root.name === llc, "named after the company", root)
  const { data: acct } = await db.from("accounts").select("drive_folder_id, state_of_formation").eq("id", m.account_id).single()
  check(acct.drive_folder_id === null, "no Drive folder for the company", acct)
  const { data: allFiles } = await db.from("store_files").select("name, document_type").eq("owner_id", fOwner.id)
  check((allFiles ?? []).length >= 4, "all the formation files came along (summary, Articles, SS-4, EIN)", allFiles)
  const { data: docs } = await db.from("documents").select("id, account_id, drive_file_id").in("drive_file_id", [art, ss4, ein].map((x) => (x.status === "saved" ? x.pointer : "")))
  check((docs ?? []).length === 3 && docs.every((d: { account_id: string }) => d.account_id === m.account_id), "their CRM records now carry the company", docs)
  check(((await db.from("store_owners").select("id").eq("contact_id", contactId).eq("kind", "person")).data ?? []).length === 1, "the person keeps their own storage (contract + passport)")
  const { findWelcomeDocsFromRecords } = await import("../../../lib/operations/welcome-docs")
  const w = await findWelcomeDocsFromRecords(m.account_id as string)
  // The SANDBOX catalog has no "ein_irs_fax_ltr_147c" entry (production does), so the record has no label here and the welcome package cannot
  // match it by label; that lookup is proved by tests/unit/formation-upload-chosen-type.test.ts. Here: the Articles are found, the EIN row exists.
  check(!!w.articles, "the welcome package finds the Articles of the new company (no Drive folder)", w)

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
