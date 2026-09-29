/* eslint-disable no-console -- proof script: prints pass/fail lines */
/* eslint-disable no-restricted-syntax -- sandbox-only proof fixtures ("ZZ S6" rows), not business writes */
/**
 * CRM Store — slice S6 proofs: the Formation pilot (master plan v4.5 §8.9 #6, job 685467b5). SANDBOX ONLY.
 *   npx tsx scripts/crm-store/s6-proofs.ts
 *
 * Runs the REAL formation code on throwaway "ZZ S6" clients — a PILOT buyer and a normal TWIN side by
 * side — and checks the database afterwards:
 *   the wizard-submit job (passport → the buyer's personal storage, OCR from bytes, Formation Summary,
 *   no Drive for the pilot) · the Articles upload save (1. Company, service-case link, version on a
 *   corrected re-upload, unchanged on the same bytes, one CRM documents row) · company creation (the
 *   handover in ONE logged step, CRM rows the same as the twin's, a re-run adds nothing) · the SS-4 IRS
 *   package reads the Articles from the store (pages counted) · staff-only files can never be shown ·
 *   a second formation of the same buyer gets its own storage · cancel → archived, reactivate → back ·
 *   a store failure is reported (the caller then runs today's path) · the switch is off outside the
 *   sandbox / for unlisted buyers · the backup lands in the REAL test Shared Drive (in formation first,
 *   then under Wyoming with the company name).
 * The pilot setting gets the fixture buyers for the run and loses them at the end. Rows stay under "ZZ S6".
 */
import { config } from "dotenv"
config({ path: ".env.local" })

import { randomUUID } from "crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
import type { BackupConfig } from "@/lib/crm-store/backup"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"

let failures = 0
function check(cond: unknown, msg: string, extra?: unknown) {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.log(`  FAIL  ${msg}`, extra === undefined ? "" : JSON.stringify(extra)) }
}

async function pdf(lines: string[], pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([612, 792])
    lines.forEach((l, j) => p.drawText(`${l} (p${i + 1})`, { x: 50, y: 740 - j * 16, size: 11, font: f }))
  }
  return Buffer.from(await d.save())
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(SANDBOX_REF)) throw new Error("not the sandbox — refusing")
  process.env.SANDBOX_MODE = "1"
  delete process.env.GOOGLE_DRIVE_LIVE // formation steps run on the mocked Drive; the backup step switches it on
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const pilot = await import("@/lib/crm-store/formation-pilot")
  const { readStoreFile } = await import("@/lib/crm-store/document-pointer")
  const { handleFormationSetup } = await import("@/lib/jobs/handlers/formation-setup")
  const { materializeFormationCompany } = await import("@/lib/operations/formation-materialize")
  const { resolveArticlesForSs4 } = await import("@/lib/ss4/resolve-articles-pdf")
  const { backupOwner } = await import("@/lib/crm-store/backup")
  const drive = await import("@/lib/google-drive")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const tag = Date.now()

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────
  const insert = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await db.from(table).insert(row).select("id").single()
    if (error) throw new Error(`${table}: ${error.message}`)
    return data.id as string
  }
  const person = async (first: string) => insert("contacts", {
    first_name: first, last_name: `S6 ${tag}`, full_name: `ZZ ${first} S6 ${tag}`, email: `zz-s6-${first.toLowerCase()}-${tag}@example.test`,
  })
  const buyer = await person("Pilot")
  const twin = await person("Twin")
  const formationCase = (contactId: string, suffix: string) => insert("service_deliveries", {
    service_type: "Company Formation", service_name: `Company Formation - ZZ S6 ${suffix} ${tag}`,
    contact_id: contactId, account_id: null, status: "active", stage: "Payment Confirmed", stage_order: 1,
  })
  const sdA = await formationCase(buyer, "Pilot")
  const sdT = await formationCase(twin, "Twin")
  const chosen = (who: string) => `ZZ S6 ${who} LLC ${tag}`
  const answers = (who: string, email: string, passportPath: string) => ({
    owner_first_name: who, owner_last_name: `S6 ${tag}`, owner_email: email, owner_phone: "+1 555 0100",
    owner_dob: "1980-05-06", owner_nationality: "Italy", owner_street: "Via Roma 1", owner_city: "Milano",
    owner_state_province: "MI", owner_zip: "20100", owner_country: "Italy", owner_is_signer: true,
    entity_type: "SMLLC", state_of_formation: "WY", member_count: 0, business_purpose: "Consulting",
    llc_name_1: chosen(who), llc_name_2: `${chosen(who)} Two`, llc_name_3: `${chosen(who)} Three`,
    chosen_name_final: chosen(who), disclaimer_accepted: true, passport_owner: passportPath,
  })
  const upload = async (path: string, bytes: Buffer) => {
    const { error } = await db.storage.from("onboarding-uploads").upload(path, bytes, { contentType: "application/pdf", upsert: true })
    if (error) throw new Error(`upload ${path}: ${error.message}`)
  }
  const passportBytes = await pdf(["ZZ S6 passport — not a real document"])
  const pA = `zz-s6/${tag}/pilot/passport_owner.pdf`
  const pT = `zz-s6/${tag}/twin/passport_owner.pdf`
  await upload(pA, passportBytes)
  await upload(pT, passportBytes)
  const dataA = answers("Pilot", `zz-s6-pilot-${tag}@example.test`, pA)
  const dataT = answers("Twin", `zz-s6-twin-${tag}@example.test`, pT)
  for (const [c, sd, data] of [[buyer, sdA, dataA], [twin, sdT, dataT]] as const) {
    await insert("wizard_progress", { contact_id: c, wizard_type: "formation", status: "submitted", data, service_delivery_id: sd })
  }

  // the switch: add the fixture buyer (keep whatever else is listed)
  const { data: setRow } = await db.from("app_settings").select("value").eq("key", pilot.PILOT_SETTINGS_KEY).maybeSingle()
  const before = ((setRow?.value as { contact_ids?: string[] } | null)?.contact_ids ?? []).filter((x) => typeof x === "string")
  await db.from("app_settings").upsert({ key: pilot.PILOT_SETTINGS_KEY, value: { contact_ids: [...before, buyer] }, updated_at: new Date().toISOString() })

  const ownerRow = async (sd: string) => (await db.from("store_owners").select("id, kind, account_id, lifecycle_override").eq("service_delivery_id", sd).maybeSingle()).data
  const filesOf = async (ownerId: string) => (await db.from("store_files")
    .select("id, name, document_type, published, state, current_version_id, folder_id, store_folders!store_files_folder_id_fkey(kind, name)")
    .eq("owner_id", ownerId)).data as Array<Record<string, unknown>>
  const docRows = async (pointer: string) => (await db.from("documents").select("id, account_id, contact_id, service_delivery_id, portal_visible, drive_link").eq("drive_file_id", pointer)).data as Array<Record<string, unknown>>
  const events = async (ownerId: string, event: string) => ((await db.from("store_events").select("id").eq("owner_id", ownerId).eq("event", event)).data ?? []).length
  const job = (contactId: string, data: Record<string, unknown>) => ({
    id: randomUUID(), job_type: "formation_setup", status: "processing", attempts: 1, max_attempts: 3,
    payload: { token: `portal-zz-s6-${tag}`, submission_id: null, contact_id: contactId, lead_id: null, submitted_data: data, source: "portal_wizard" },
  })

  try {
    console.log("\n1. the switch")
    check(!pilot.pilotEnvironmentAllowed({ SANDBOX_MODE: "1", NEXT_PUBLIC_SUPABASE_URL: "https://ydzipybqeebtpcvsbtvs.supabase.co" }), "off on the production database")
    check(await pilot.isStorePilotContact(buyer), "on for the listed buyer")
    check(!(await pilot.isStorePilotContact(twin)), "off for an unlisted buyer")

    console.log("\n2. payment — the company-being-formed's storage exists before anything is saved")
    const ownerA = await pilot.ensureFormationOwner({ id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, await pilot.formationRootName(buyer))
    check(ownerA?.kind === "formation", "pilot formation → an in-formation owner", ownerA)
    const again = await pilot.ensureFormationOwner({ id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, "ignored")
    check(again?.id === ownerA?.id, "idempotent (same owner on a second call)")
    check((await pilot.ensureFormationOwner({ id: sdT, contact_id: twin, account_id: null, service_type: "Company Formation" }, "x")) === null, "twin → no store owner")
    const folders = (await db.from("store_folders").select("name, parent_id").eq("owner_id", ownerA!.id)).data as Array<{ name: string; parent_id: string | null }>
    check(folders.filter((f) => f.parent_id).map((f) => f.name).sort().join("|") === "1. Company|2. Contacts|3. Tax|4. Banking|5. Correspondence", "the five company folders", folders)

    console.log("\n3. wizard submit (the REAL job) — pilot vs twin")
    const rA = await handleFormationSetup(job(buyer, dataA) as never)
    const rT = await handleFormationSetup(job(twin, dataT) as never)
    const stepsA = new Map(rA.steps.map((s) => [s.name, s]))
    const stepsT = new Map(rT.steps.map((s) => [s.name, s]))
    check(stepsA.get("store_passport")?.status === "ok", "pilot: passport saved in the store", stepsA.get("store_passport"))
    check(!stepsA.has("drive_folder") && !stepsA.has("passport_copy"), "pilot: no Drive contact folder, no Drive passport copy")
    check(stepsT.has("drive_folder"), "twin: today's Drive step ran", stepsT.get("drive_folder"))
    check(stepsA.get("store_formation_summary")?.status === "ok", "pilot: Formation Summary saved", stepsA.get("store_formation_summary"))
    check(!stepsT.has("store_formation_summary"), "twin: no summary (not a pilot)")
    const personOwner = (await db.from("store_owners").select("id").eq("contact_id", buyer).maybeSingle()).data?.id as string
    const personFiles = await filesOf(personOwner)
    const passport = personFiles.find((f) => f.document_type === "passport")
    check(passport && (passport.store_folders as { kind: string }).kind === "personal", "passport in the buyer's own 'Personal documents'", personFiles)
    const passRows = await docRows(`store:${passport?.id}`)
    check(passRows.length === 1 && passRows[0].portal_visible === true && passRows[0].contact_id === buyer, "one CRM documents row for it, shown in the portal as today", passRows)
    const rA2 = await handleFormationSetup(job(buyer, dataA) as never)
    check(rA2.steps.find((s) => s.name === "store_passport")?.detail === "CRM Store: unchanged", "re-run: passport unchanged", rA2.steps.find((s) => s.name === "store_passport"))
    check((await docRows(`store:${passport?.id}`)).length === 1, "re-run: still one documents row")
    check(!rA2.steps.some((s) => s.name === "passport_ocr"), "re-run: no second OCR")
    const coFiles = await filesOf(ownerA!.id)
    const summary = coFiles.find((f) => f.document_type === "formation_summary")
    check(summary && (summary.store_folders as { name: string }).name === "1. Company", "summary in '1. Company' of the company being formed", coFiles)
    check(rA2.steps.find((s) => s.name === "store_formation_summary")?.detail === "CRM Store: unchanged", "re-run: same answers → summary unchanged")

    console.log("\n4. Articles upload at 'Filed with State'")
    await db.from("service_deliveries").update({ stage: "Filed with State", stage_order: 3 }).eq("id", sdA)
    const articles1 = await pdf(["ARTICLES OF ORGANIZATION", chosen("Pilot"), "Wyoming Secretary of State"], 2)
    const up1 = await pilot.pilotSaveFormationUpload({ sd: { id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: articles1, mimeType: "application/pdf" })
    check(up1.status === "saved" && up1.write === "created", "saved (created)", up1)
    const art = up1.status === "saved" ? up1.fileId : ""
    const artRow = (await db.from("store_files").select("document_type, published, owner_id").eq("id", art).single()).data
    check(artRow.document_type === "articles_of_organization" && artRow.owner_id === ownerA!.id, "type + owner right")
    check(artRow.published === true, "published (Filed with State is a client-safe stage, as today's rule)")
    const link = (await db.from("store_record_links").select("link_kind, record_id, stage_at_creation").eq("file_id", art)).data
    check(link?.some((l: Record<string, unknown>) => l.link_kind === "service_case" && l.record_id === sdA && l.stage_at_creation === "Filed with State"), "linked to the service case + stage", link)
    const up2 = await pilot.pilotSaveFormationUpload({ sd: { id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: articles1, mimeType: "application/pdf" })
    check(up2.status === "saved" && up2.write === "unchanged" && up2.fileId === art, "same file again → unchanged", up2)
    const articles2 = await pdf(["ARTICLES OF ORGANIZATION (corrected)", chosen("Pilot")], 2)
    const up3 = await pilot.pilotSaveFormationUpload({ sd: { id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: articles2, mimeType: "application/pdf" })
    check(up3.status === "saved" && up3.write === "versioned" && up3.fileId === art, "corrected re-upload (same name) → new VERSION of the same file (not '(2)')", up3)
    check((await docRows(`store:${art}`)).length === 1, "one CRM documents row for the Articles")
    const cp575 = await pilot.pilotSaveFormationUpload({ sd: { id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "EIN Received", fileName: "CP575.pdf", bytes: await pdf(["CP575"]), mimeType: "application/pdf" })
    const l147c = await pilot.pilotSaveFormationUpload({ sd: { id: sdA, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "EIN Received", fileName: "147C.pdf", bytes: await pdf(["147C"]), mimeType: "application/pdf" })
    check(cp575.status === "saved" && l147c.status === "saved" && cp575.fileId !== l147c.fileId && l147c.write === "created",
      "two DIFFERENT documents at the same stage (CP575 + 147C) stay two files", { cp575, l147c })
    const noOwnerUpload = await pilot.pilotSaveFormationUpload({ sd: { id: sdT, contact_id: twin, account_id: null, service_type: "Company Formation" }, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: articles1, mimeType: "application/pdf" })
    check(noOwnerUpload.status === "not_pilot" && (await ownerRow(sdT)) === null, "an upload never CREATES a formation's storage (the twin stays on today's path)", noOwnerUpload)
    check((await readStoreFile(art)).bytes.equals(articles2), "reading the file serves the CURRENT version")

    console.log("\n5. company creation (the REAL step) — pilot vs twin")
    const mA = await materializeFormationCompany({ contact_id: buyer, formation_state: "WY", entity_type: "SMLLC", chosen_name: chosen("Pilot"), formation_date: "2026-09-26", actor: "zz-s6-proof" })
    const mT = await materializeFormationCompany({ contact_id: twin, formation_state: "WY", entity_type: "SMLLC", chosen_name: chosen("Twin"), formation_date: "2026-09-26", actor: "zz-s6-proof" })
    check(mA.success && mT.success, "both companies created", { a: mA.outcome, t: mT.outcome, ae: mA.error, te: mT.error })
    const hand = mA.steps.find((s) => s.step === "store_handover")
    check(hand?.status === "ok", "pilot: handover step ok", hand)
    const oA = await ownerRow(sdA)
    check(oA?.kind === "company" && oA.account_id === mA.account_id && oA.lifecycle_override === null, "the same owner is now the company's", oA)
    check(await events(ownerA!.id, "formation_attached") === 1, "exactly ONE handover event")
    const root = (await db.from("store_folders").select("name").eq("owner_id", ownerA!.id).is("parent_id", null).single()).data
    check(root.name === chosen("Pilot"), "root folder renamed to the company name", root)
    check((await ownerRow(sdT)) === null, "twin: still no store owner")
    const DRIVE_OR_STORE = new Set(["drive_folder", "drive_migration", "owner_passport_copy", "flow_docs_to_drive", "store_handover"])
    const shape = (steps: { step: string; status: string }[]) => steps.filter((s) => !DRIVE_OR_STORE.has(s.step) && !/^member_\d+_passport$/.test(s.step)).map((s) => `${s.step}:${s.status}`).join(" ")
    check(shape(mA.steps) === shape(mT.steps), "every non-file step identical to the twin's", { pilot: shape(mA.steps), twin: shape(mT.steps) })
    const acc = async (id: string) => (await db.from("accounts").select("status, entity_type, state_of_formation, formation_date, drive_folder_id").eq("id", id).single()).data
    const aA = await acc(mA.account_id!), aT = await acc(mT.account_id!)
    check(aA.status === aT.status && aA.entity_type === aT.entity_type && aA.state_of_formation === aT.state_of_formation && aA.formation_date === aT.formation_date, "company record identical to the twin's (status, type, state, date)", { aA, aT })
    check(aA.drive_folder_id === null, "the pilot company gets no Drive folder of its own (Drive = backup)", aA.drive_folder_id)
    check(mA.steps.find((s) => s.step === "drive_folder")?.status === "skipped" && mT.steps.find((s) => s.step === "drive_folder")?.status !== "skipped",
      "the pilot skipped the Drive company folder; the twin ran today's Drive step (blocked by the sandbox's fake Drive)",
      { pilot: mA.steps.find((s) => s.step === "drive_folder"), twin: mT.steps.find((s) => s.step === "drive_folder") })
    const links = async (id: string) => ((await db.from("account_contacts").select("role").eq("account_id", id)).data ?? []).map((r: { role: string }) => r.role).sort().join(",")
    check(await links(mA.account_id!) === await links(mT.account_id!), "same contact links as the twin", { a: await links(mA.account_id!), t: await links(mT.account_id!) })
    const sdRow = async (id: string) => (await db.from("service_deliveries").select("account_id, service_name").eq("id", id).single()).data
    check((await sdRow(sdA)).account_id === mA.account_id && (await sdRow(sdT)).account_id === mT.account_id, "each formation case linked to its company")
    const artDoc = (await docRows(`store:${art}`))[0]
    check(artDoc.account_id === mA.account_id, "the Articles' CRM row now carries the company (today's backfill)", artDoc)
    const mA2 = await materializeFormationCompany({ contact_id: buyer, formation_state: "WY", entity_type: "SMLLC", chosen_name: chosen("Pilot"), actor: "zz-s6-proof" })
    check(mA2.outcome === "already_materialized", "re-run → already a company")
    check(await events(ownerA!.id, "formation_attached") === 1, "re-run → still ONE handover event")
    const verCount = ((await db.from("store_file_versions").select("id").eq("file_id", art)).data ?? []).length
    check(verCount === 2, "re-run → no new file versions", verCount)

    console.log("\n6. SS-4: the IRS package finds the Articles in the store")
    const found = await resolveArticlesForSs4({ serviceDeliveryId: sdA, accountId: mA.account_id! })
    check(found && found.equals(articles2), "the resolver returns the CURRENT Articles from the store")
    const ss4 = await pdf(["FORM SS-4 (signed) — ZZ"], 2)
    const merged = await PDFDocument.create({ updateMetadata: false })
    for (const [bytes, idx] of [[ss4, [0]], [found!, null]] as const) {
      const src = await PDFDocument.load(bytes)
      for (const p of await merged.copyPages(src, idx ? [...idx] : src.getPageIndices())) merged.addPage(p)
    }
    const pkg = Buffer.from(await merged.save())
    check((await PDFDocument.load(pkg)).getPageCount() === 3, "package = SS-4 page 1 + both Articles pages (3 pages)")
    const savedPkg = await pilot.pilotSaveCaseFile({ caseId: sdA, folderKind: "company", documentType: "irs_fax", callerKey: `ss4-irs-package:zz-${tag}`, name: "Form SS-4 - ZZ - For IRS.pdf", bytes: pkg, mimeType: "application/pdf", published: false,
      row: { account_id: mA.account_id!, service_delivery_id: sdA, document_type_name: "SS-4 + Articles (IRS Package)", category: 1, portal_visible: false } })
    check(savedPkg.status === "saved", "package saved in the company's storage", savedPkg)

    console.log("\n7. the Formation Summary can never be shown to a client; the SS-4 package is hidden by default but shareable (Antonio 2026-08-04)")
    const vis = async (id: string) => (await db.rpc("store_file_client_visible", { p_file_id: id })).data
    const pkgId = savedPkg.status === "saved" ? savedPkg.fileId : ""
    check(await vis(summary!.id as string) === false && await vis(pkgId) === false, "summary + IRS package not visible by default")
    const pub = await db.rpc("store_set_published", { p_file_id: summary!.id, p_published: true, p_actor: null })
    check(!!pub.error && /staff-only/.test(pub.error.message), "publishing the summary is refused", pub.error?.message)
    await db.from("store_files").update({ published: true }).eq("id", summary!.id)
    check(await vis(summary!.id as string) === false, "even with its published flag forced on, the summary stays hidden")
    const pubPkg = await db.rpc("store_set_published", { p_file_id: pkgId, p_published: true, p_actor: null })
    check(!pubPkg.error && await vis(pkgId) === true, "the SS-4 package CAN be published by staff (not staff-only)", pubPkg.error?.message)
    await db.rpc("store_set_published", { p_file_id: pkgId, p_published: false, p_actor: null })
    check(await vis(art) === true, "the Articles (official company document) ARE visible")
    const { updateDocument } = await import("@/lib/operations/document")
    const sumRow = (await docRows(`store:${summary!.id}`))[0]
    const share = await updateDocument({ id: sumRow.id as string, patch: { portal_visible: true }, clientAlert: false } as never)
    check(!share.success && /staff-only/.test(share.error ?? ""), "the CRM refuses to share the summary with the client (contact-page toggle / MCP path)", share)
    check((await docRows(`store:${summary!.id}`))[0].portal_visible === false, "…and its row stays hidden")
    const { staffOnlyStorePointers } = await import("@/lib/crm-store/document-pointer")
    const blocked = await staffOnlyStorePointers([`store:${summary!.id}`, `store:${pkgId}`, `store:${art}`, `store:${passport?.id}`, `store:${randomUUID()}`])
    check(blocked.size === 2 && blocked.has(`store:${summary!.id}`) && !blocked.has(`store:${pkgId}`) && !blocked.has(`store:${art}`) && !blocked.has(`store:${passport?.id}`),
      "the portal download refuses exactly the summary (+ an unknown file, fail-closed) — package, Articles, passport follow their CRM row as today", Array.from(blocked))

    console.log("\n8. a returning client's second formation gets its own storage")
    const sdA2 = await formationCase(buyer, "Pilot second")
    const o2 = await pilot.ensureFormationOwner({ id: sdA2, contact_id: buyer, account_id: null, service_type: "Company Formation" }, "second")
    check(o2 && o2.id !== ownerA!.id && o2.kind === "formation", "a separate in-formation owner", o2)

    console.log("\n9. cancel → archived, reactivate → back (any status writer)")
    await db.from("service_deliveries").update({ status: "cancelled" }).eq("id", sdA2)
    check((await ownerRow(sdA2))?.lifecycle_override === "archived", "cancelled → archived")
    await db.from("service_deliveries").update({ status: "active" }).eq("id", sdA2)
    check((await ownerRow(sdA2))?.lifecycle_override === "in_formation", "reactivated → in formation again")
    await db.from("service_deliveries").update({ status: "cancelled" }).eq("id", sdA)
    const afterCo = await ownerRow(sdA)
    check(afterCo?.kind === "company" && afterCo.lifecycle_override === null, "an attached company's storage is untouched by cancelling its old formation case", afterCo)
    await db.from("service_deliveries").update({ status: "active" }).eq("id", sdA)

    console.log("\n10. a store failure is reported and the caller falls back")
    const sdBroken = await formationCase(buyer, "Pilot broken")
    const { data: brokenOwner } = await db.rpc("store_ensure_owner", { p_kind: "formation", p_ref: sdBroken }) // no folders on purpose
    const broken = await pilot.pilotSaveFormationUpload({ sd: { id: sdBroken, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "Filed with State", fileName: "Articles.pdf", bytes: articles1, mimeType: "application/pdf" })
    check(broken.status === "failed", "save failed → 'failed' (the upload route then keeps today's copy)", broken)
    const alarm = (await db.from("store_events").select("reason").eq("owner_id", brokenOwner).eq("event", "pilot_alarm")).data
    check(alarm?.some((a: { reason: string }) => a.reason === "store_save_failed"), "alarm recorded", alarm)
    const attachBad = await pilot.attachFormationToCompany(sdA2, mT.account_id!, "wrong")
    check(attachBad.status === "failed" && /not linked/.test(attachBad.status === "failed" ? attachBad.error : ""), "handing a formation to a company it is NOT linked to is refused → failed + alarm, never a throw", attachBad)
    check((await ownerRow(sdA2))?.kind === "formation", "…and the formation's storage is untouched")

    console.log("\n13. a returning client with TWO open formations — never a silent split")
    const buyerU = await person("Twice")
    const sdU1 = await formationCase(buyerU, "Twice one")
    const sdU2 = await formationCase(buyerU, "Twice two")
    await insert("wizard_progress", { contact_id: buyerU, wizard_type: "formation", status: "submitted", data: answers("Twice", `zz-s6-twice-${tag}@example.test`, pA), service_delivery_id: sdU1 })
    await db.from("app_settings").upsert({ key: pilot.PILOT_SETTINGS_KEY, value: { contact_ids: [...before, buyer, buyerU] }, updated_at: new Date().toISOString() })
    const oU = await pilot.ensureFormationOwner({ id: sdU1, contact_id: buyerU, account_id: null, service_type: "Company Formation" }, "twice")
    const mU = await materializeFormationCompany({ contact_id: buyerU, formation_state: "WY", entity_type: "SMLLC", chosen_name: chosen("Twice"), formation_date: "2026-09-26", actor: "zz-s6-proof" })
    const hU = mU.steps.find((x) => x.step === "store_handover")
    const alarmU = (await db.from("store_events").select("reason").eq("owner_id", oU!.id).eq("event", "pilot_alarm")).data
    check(mU.success && hU?.status === "error" && alarmU?.some((a: { reason: string }) => a.reason === "formation_case_not_linked"),
      "neither case could be linked (today's 'needs manual review') → the store files stay put AND an alarm is raised", { outcome: mU.outcome, hU, alarmU })
    check((await ownerRow(sdU1))?.kind === "formation", "…the formation's storage is untouched (nothing guessed)")
    check(!!sdU2, "(second open case present)")

    console.log("\n14. workspace 'Go Back': the stage's store files go to the store trash, never orphaned")
    const { revertServiceDelivery } = await import("@/lib/operations/service-delivery")
    const staffId = (await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })).data.users[0]?.id as string
    check(!!staffId, "a sandbox staff login exists for the trash actor", staffId)
    await db.from("service_deliveries").update({ stage: "Filed with State", stage_order: 3 }).eq("id", sdA2)
    const upB = await pilot.pilotSaveFormationUpload({ sd: { id: sdA2, contact_id: buyer, account_id: null, service_type: "Company Formation" }, flowStage: "Filed with State", fileName: "Articles B.pdf", bytes: await pdf(["ARTICLES B"]), mimeType: "application/pdf" })
    await db.from("service_deliveries").update({ stage: "Articles Received", stage_order: 4 }).eq("id", sdA2)
    const noActor = await revertServiceDelivery({ delivery_id: sdA2, actor: "zz-s6-proof" })
    const bId = upB.status === "saved" ? upB.fileId : ""
    const stateB = async () => (await db.from("store_files").select("state").eq("id", bId).single()).data?.state
    check(noActor.success && await stateB() === "live" && (await docRows(`store:${bId}`)).length === 1, "without a known staff member: the store file stays live AND stays listed", { noActor, st: await stateB() })
    await db.from("service_deliveries").update({ stage: "Articles Received", stage_order: 4 }).eq("id", sdA2)
    const withActor = await revertServiceDelivery({ delivery_id: sdA2, actor: "zz-s6-proof", actor_user_id: staffId })
    check(withActor.success && await stateB() === "trashed" && (await docRows(`store:${bId}`)).length === 0, "with the staff member: file in the store's trash, CRM row removed (as today)", { withActor, st: await stateB() })

    console.log("\n12. a multi-member formation: each member's passport goes to the member's own storage")
    const buyerM = await person("Multi")
    const sdM = await formationCase(buyerM, "Multi")
    const mPass = `formation/zz-s6-${tag}/member_0_member_passport.pdf`
    const oPass = `formation/zz-s6-${tag}/passport_owner_multi.pdf`
    await upload(mPass, await pdf(["ZZ S6 member passport — not real"]))
    await upload(oPass, passportBytes)
    const memberEmail = `zz-s6-member-${tag}@example.test`
    const dataM = {
      ...answers("Multi", `zz-s6-multi-${tag}@example.test`, oPass), entity_type: "MMLLC", member_count: 1,
      member_0_member_type: "individual", member_0_member_first_name: "Member", member_0_member_last_name: `S6 ${tag}`,
      member_0_member_email: memberEmail, member_0_member_ownership_pct: 40, member_0_member_nationality: "Spain",
      member_0_member_dob: "1985-03-04", member_0_member_passport: mPass,
    }
    await insert("wizard_progress", { contact_id: buyerM, wizard_type: "formation", status: "submitted", data: dataM, service_delivery_id: sdM })
    await db.from("app_settings").upsert({ key: pilot.PILOT_SETTINGS_KEY, value: { contact_ids: [...before, buyer, buyerM] }, updated_at: new Date().toISOString() })
    await pilot.ensureFormationOwner({ id: sdM, contact_id: buyerM, account_id: null, service_type: "Company Formation" }, await pilot.formationRootName(buyerM))
    await handleFormationSetup(job(buyerM, dataM) as never)
    const mM = await materializeFormationCompany({ contact_id: buyerM, formation_state: "WY", entity_type: "MMLLC", chosen_name: chosen("Multi"), formation_date: "2026-09-26", actor: "zz-s6-proof" })
    check(mM.success, "multi-member company created", { outcome: mM.outcome, error: mM.error })
    check(mM.steps.find((x) => x.step === "member_1_passport")?.detail?.startsWith("CRM Store:"), "member passport step: saved in the store", mM.steps.filter((x) => /member|store|drive/.test(x.step)))
    const memberContact = (await db.from("contacts").select("id").eq("email", memberEmail).maybeSingle()).data?.id as string
    const memberOwner = memberContact ? (await db.from("store_owners").select("id").eq("contact_id", memberContact).maybeSingle()).data?.id as string : undefined
    const mFiles = memberOwner ? await filesOf(memberOwner) : []
    const mp = mFiles.find((f) => f.document_type === "passport")
    check(mp && (mp.store_folders as { kind: string }).kind === "personal", "in the MEMBER's own personal storage", mFiles)
    const mSubj = mp ? (await db.from("store_file_subjects").select("subject_kind, account_id, role").eq("file_id", mp.id)).data : []
    check(mSubj?.some((x: Record<string, unknown>) => x.subject_kind === "company" && x.account_id === mM.account_id && x.role === "owner_member"), "its subject is the company (owner / member)", mSubj)
    const mLinks = mp ? (await db.from("store_record_links").select("link_kind").eq("file_id", mp.id)).data : []
    check((mLinks ?? []).length === 0, "not linked to the buyer's formation case (the store would refuse it)", mLinks)
    const mRow = mp ? (await docRows(`store:${mp.id}`)) : []
    check(mRow.length === 1 && mRow[0].contact_id === memberContact && mRow[0].account_id === mM.account_id && mRow[0].portal_visible === true, "one CRM documents row, same fields as today's", mRow)
    check(mM.steps.find((x) => x.step === "store_handover")?.status === "ok", "handover ok")

    console.log("\n11. backup into the REAL test Shared Drive")
    process.env.GOOGLE_DRIVE_LIVE = "1"
    process.env.GOOGLE_SHARED_DRIVE_ID = TEST_DRIVE
    const top = ((await drive.createFolder(TEST_DRIVE, `ZZ S6 pilot proof ${tag}`)) as { id: string }).id
    const mk = async (parent: string, name: string) => ((await drive.createFolder(parent, name)) as { id: string }).id
    const cfg: BackupConfig = { mainDriveId: TEST_DRIVE, companiesRoot: await mk(top, "Companies"), privateDriveId: TEST_DRIVE, restrictedRoot: await mk(top, "Private - Restricted"), protectedRoot: await mk(top, "Private - Protected") }
    await db.from("store_backup_places").delete().like("place_key", "state:%")
    await db.from("store_backup_places").delete().in("place_key", ["people", "unfiled", "in_formation", "unplaced"])
    // the second pilot formation (still being formed) → "_In formation"
    await pilot.savePilotFile({ ownerId: o2!.id, folderKind: "company", name: "Articles draft.pdf", bytes: articles1, mimeType: "application/pdf", documentType: "articles_of_organization", callerKey: `zz-s6-inform-${tag}`, links: [{ kind: "service_case", recordId: sdA2 }] })
    // the real Drive path of a backed-up file, walked up from the file itself (names only)
    const pathOf = async (fileId: string): Promise<string> => {
      const names: string[] = []
      let cur: string | undefined = fileId
      for (let i = 0; i < 8 && cur; i++) {
        const m = (await drive.getFileMetadata(cur)) as { name: string; parents?: string[] }
        names.unshift(m.name)
        cur = m.parents?.[0]
        if (cur === top) break
      }
      return names.join(" / ")
    }
    const refFor = async (storeFileId: string) => (await db.from("store_external_refs").select("external_id").eq("direction", "backup").eq("object_kind", "file").eq("object_id", storeFileId).maybeSingle()).data?.external_id as string | undefined
    const b1 = await backupOwner(o2!.id, { config: cfg, force: true })
    const o2Files = await filesOf(o2!.id)
    const inFormFile = o2Files.find((f) => f.state === "live" && f.name === "Articles draft.pdf")
    const trashedB = o2Files.find((f) => f.state === "trashed")
    const pT = trashedB ? await pathOf((await refFor(trashedB.id as string))!) : ""
    check(pT.includes("Private - Protected"), "the file trashed by 'Go Back' is backed up in the private protected area", pT)
    const p1 = inFormFile ? await pathOf((await refFor(inFormFile.id as string))!) : ""
    check(b1.status === "done" && p1.includes("_In formation"), "a company being formed is backed up under '_In formation'", { b1: b1.status, path: p1, err: (b1 as { error?: string }).error })
    const b2 = await backupOwner(ownerA!.id, { config: cfg, force: true })
    const paths: string[] = []
    for (const id of [summary!.id as string, art, pkgId]) { const ext = await refFor(id); if (ext) paths.push(await pathOf(ext)) }
    check(b2.status === "done" && paths.length === 3 && paths.every((p) => p.includes("Wyoming") && p.includes(chosen("Pilot")) && p.includes("1. Company")),
      "the created company's files are backed up under Wyoming / the company / 1. Company", { b2: b2.status, paths, err: (b2 as { error?: string }).error })
    const b3 = await backupOwner(personOwner, { config: cfg, force: true })
    const passExt = await refFor(passport?.id as string)
    const pp = passExt ? await pathOf(passExt) : ""
    check(b3.status === "done" && pp.includes("Private - Restricted"), "the passport is backed up in the private area", { b3: b3.status, path: pp })
    check(!!passExt && !!(await drive.getTaggedItem(passExt)), "real file ids on the test Shared Drive", passExt)
    console.log(`\n  test Drive folder (trash by hand when done looking): https://drive.google.com/drive/folders/${top}`)
  } catch (e) {
    failures++
    console.log("  FAIL  the run stopped with an error:", e instanceof Error ? e.stack : e)
  } finally {
    await db.from("app_settings").upsert({ key: pilot.PILOT_SETTINGS_KEY, value: { contact_ids: before }, updated_at: new Date().toISOString() })
    console.log(`\n${failures === 0 ? "ALL PROOFS PASSED" : `${failures} FAILED`} (fixtures tag ${tag}; pilot setting restored)`)
    process.exit(failures === 0 ? 0 : 1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
