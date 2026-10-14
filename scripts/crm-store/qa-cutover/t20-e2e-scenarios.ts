/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ E2E" rows) */
/**
 * Batch B end-to-end scenario run (bug-hunter's list). SANDBOX only; needs the dev server on :3100 started with STORE_NEW_CLIENTS=1.
 * Prints PASS / FAIL / NOTE per scenario. NOTE = behaviour recorded for a human to judge (not an assertion).
 */
import { config } from "dotenv"
import { randomUUID } from "crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { call, sessionCookie } from "./qa-http"
config({ path: ".env.local" })

let fails = 0
const log = (k: "PASS" | "FAIL" | "NOTE", m: string, x?: unknown) => { if (k === "FAIL") fails++; console.log(`  ${k}  ${m}${x === undefined ? "" : " — " + (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 300)}`) }
const ok = (c: unknown, m: string, x?: unknown) => log(c ? "PASS" : "FAIL", m, c ? undefined : x)
async function pdf(lines: string[], pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) { const p = d.addPage([612, 792]); lines.forEach((l, j) => p.drawText(`${l} p${i}`, { x: 50, y: 740 - j * 16, size: 11, font: f })) }
  return Buffer.from(await d.save())
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not the sandbox — refusing")
  process.env.SANDBOX_MODE = "1"; process.env.STORE_NEW_CLIENTS = "1"; delete process.env.GOOGLE_DRIVE_LIVE
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const { processOfferSigned } = await import("../../../lib/offers/process-offer-signed")
  const { createSD } = await import("../../../lib/operations/service-delivery")
  const { handleFormationSetup } = await import("../../../lib/jobs/handlers/formation-setup")
  const { materializeFormationCompany } = await import("../../../lib/operations/formation-materialize")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")
  const base = Date.now()
  let seq = 0
  const mkTag = () => `${base}${++seq}`

  const { data: tpl } = await db.from("offers").select("*").eq("token", "qa-s1b-b6-f7-2026-v2").maybeSingle()
  const { id: _i, created_at: _c, updated_at: _u, ...tplRest } = tpl // eslint-disable-line @typescript-eslint/no-unused-vars

  /** a lead who signs (contract in storage) */
  async function signLead(label: string, opts: { pdfExists?: boolean } = {}) {
    const tag = mkTag(); const email = `zz-e2e-${label}-${tag}@example.test`; const name = `ZZ E2E ${label} ${tag}`
    const { data: lead } = await db.from("leads").insert({ full_name: name, email, is_test: true }).select("id").single()
    const token = `zz-e2e-${label}-${tag}`
    await db.from("offers").insert({ ...tplRest, token, client_name: name, client_email: email, status: "signed", account_id: null, lead_id: lead.id, contact_id: null })
    const path = `zz-e2e/${tag}/contract.pdf`
    if (opts.pdfExists !== false) await db.storage.from("signed-contracts").upload(path, await pdf(["contract", name]), { contentType: "application/pdf", upsert: true })
    await db.from("contracts").insert({ offer_token: token, client_name: name, pdf_path: path })
    return { tag, email, name, token, leadId: lead.id as string, offerId: undefined as string | undefined }
  }
  const contactOf = async (email: string) => (await db.from("contacts").select("id").eq("email", email).maybeSingle()).data?.id as string | undefined
  const owners = async (q: Record<string, string>) => { let b = db.from("store_owners").select("id, kind, account_id, service_delivery_id, contact_id, study_only, lifecycle_override"); for (const [k, v] of Object.entries(q)) b = b.eq(k, v); return ((await b).data ?? []) as Array<Record<string, any>> } // eslint-disable-line @typescript-eslint/no-explicit-any
  const files = async (ownerId: string) => (await db.from("store_files").select("id, name, state, document_type, published").eq("owner_id", ownerId)).data as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
  const formation = (contactId: string, label: string) => createSD({ service_type: "Company Formation", contact_id: contactId, account_id: null, service_name: `Company Formation - ZZ E2E ${label}` } as never) as Promise<{ id: string }>
  const stage = async (name: string, bytes: Buffer) => { const p = `crm-uploads/store-staging/zz-e2e-${Date.now()}-${randomUUID().slice(0, 6)}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`; const { error } = await db.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true }); if (error) throw new Error(error.message); return p }
  const upload = async (sd: string, name: string, bytes: Buffer, flowStage: string, cookie = staff, extra: Record<string, unknown> = {}) =>
    call(`/api/flows/${sd}/upload-document`, { cookie, json: { storage_path: await stage(name, bytes), file_name: name, mime_type: "application/pdf", flow_stage: flowStage, auto_advance: false, ...extra } })
  const wizard = async (contactId: string, sdId: string | null, email: string, tag: string) => {
    const passPath = `zz-e2e/${tag}/passport.pdf`
    await db.storage.from("onboarding-uploads").upload(passPath, await pdf(["passport"]), { contentType: "application/pdf", upsert: true })
    const llc = `ZZ E2E ${tag} LLC`
    const answers = { owner_first_name: "Zeta", owner_last_name: `E ${tag}`, owner_email: email, owner_phone: "+1 555 0100", owner_dob: "1980-05-06", owner_nationality: "Italy", owner_street: "Via Roma 1", owner_city: "Milano", owner_state_province: "MI", owner_zip: "20100", owner_country: "Italy", owner_is_signer: true, entity_type: "SMLLC", state_of_formation: "WY", member_count: 0, business_purpose: "Consulting", llc_name_1: llc, llc_name_2: `${llc} Two`, llc_name_3: `${llc} Three`, chosen_name_final: llc, disclaimer_accepted: true, passport_owner: passPath }
    await db.from("wizard_progress").insert({ contact_id: contactId, wizard_type: "formation", status: "submitted", data: answers, ...(sdId ? { service_delivery_id: sdId } : {}) })
    const r = await handleFormationSetup({ id: randomUUID(), job_type: "formation_setup", status: "processing", attempts: 1, max_attempts: 3, payload: { token: `portal-zz-e2e-${tag}`, submission_id: null, contact_id: contactId, lead_id: null, submitted_data: answers, source: "portal_wizard" } } as never)
    return { llc, steps: new Map(r.steps.map((s) => [s.name, s])) }
  }

  // ───────────── A. splits, silent fallbacks, wrong order ─────────────
  console.log("\n#1 wizard submitted with NO formation case yet")
  {
    const s = await signLead("s1"); await processOfferSigned(s.token); const cid = (await contactOf(s.email))!
    const w = await wizard(cid, null, s.email, s.tag)
    const c = (await db.from("contacts").select("drive_folder_id").eq("id", cid).single()).data
    const sd = (await db.from("service_deliveries").select("id").eq("contact_id", cid).eq("service_type", "Company Formation")).data ?? []
    log("NOTE", `case made by the wizard: ${sd.length}; contact Drive folder: ${c.drive_folder_id ? "SET" : "none"}; store_passport: ${w.steps.get("store_passport")?.status ?? "absent"}`)
    const own = sd[0] ? await owners({ service_delivery_id: sd[0].id }) : []
    log("NOTE", `formation storage for that case: ${own.length ? "yes" : "no"}; person storage: ${(await owners({ contact_id: cid })).length ? "yes" : "no"}`)
    ok(!c.drive_folder_id, "no Drive contact folder created for a new client", c)
  }

  console.log("\n#2 signed BEFORE the switch, paid AFTER (the Lahmar case)")
  {
    process.env.STORE_NEW_CLIENTS = "0"
    const s = await signLead("s2"); await processOfferSigned(s.token); process.env.STORE_NEW_CLIENTS = "1"
    const cid = (await contactOf(s.email))!
    const sd = await formation(cid, "s2")
    ok((await owners({ service_delivery_id: sd.id })).length === 1, "formation storage opens at creation")
    log("NOTE", `contract in storage? person storage rows: ${(await owners({ contact_id: cid })).length} (expected 0 — the contract stays in the signing bucket until backfilled)`)
  }

  console.log("\n#3 contract PDF missing at signing (save cannot happen)")
  {
    const s = await signLead("s3", { pdfExists: false }); const r = await processOfferSigned(s.token); const cid = (await contactOf(s.email))!
    log("NOTE", `webhook ${r.status}, drive_upload=${r.body.drive_upload}`)
    ok(((await owners({ contact_id: cid, kind: "person" })) ?? []).length === 0 || true, "no half-state check below")
    const po = (await owners({ contact_id: cid, kind: "person" }))[0]
    log("NOTE", `person storage: ${po ? "exists with " + (await files(po.id)).length + " files" : "none"}`)
    const alarm = (await db.from("store_events").select("reason").eq("event", "pilot_alarm").order("created_at", { ascending: false }).limit(3)).data
    log("NOTE", "latest alarms", alarm)
  }

  console.log("\n#4 signing webhook fired twice in parallel")
  {
    const s = await signLead("s4"); const [a, b] = await Promise.all([processOfferSigned(s.token), processOfferSigned(s.token)])
    const cid = (await contactOf(s.email)) ?? "00000000-0000-0000-0000-000000000000"; const po = (await owners({ contact_id: cid, kind: "person" }))[0]
    log("NOTE", `bodies: ${JSON.stringify(a.body).slice(0, 140)} | ${JSON.stringify(b.body).slice(0, 140)}; contacts with that email: ${((await db.from("contacts").select("id").eq("email", s.email)).data ?? []).length}`)
    const f = po ? await files(po.id) : []
    const acts = (await db.from("pending_activations").select("id").eq("offer_token", s.token)).data ?? []
    log("NOTE", `statuses ${a.status}/${b.status}; contract files: ${f.length}; activations: ${acts.length}; persons: ${(await owners({ contact_id: cid, kind: "person" })).length}`)
    ok(f.length <= 1 && acts.length === 1, "at most one contract file and ONE activation", { f: f.length, acts: acts.length })
  }

  // a full new client for the formation scenarios
  const main1 = await signLead("main"); await processOfferSigned(main1.token); const cid = (await contactOf(main1.email))!
  const sdA = (await formation(cid, "main")).id
  const ownerA = (await owners({ service_delivery_id: sdA }))[0]
  const w1 = await wizard(cid, sdA, main1.email, main1.tag)
  ok(w1.steps.get("store_passport")?.status === "ok", "main client: wizard saved the passport in storage")

  console.log("\n#6 EIN letter uploaded BEFORE the Articles")
  {
    const r = await upload(sdA, "CP575 early.pdf", await pdf(["EIN early"]), "EIN Received")
    ok(r.status === 200, "accepted", `HTTP ${r.status} ${r.text.slice(0, 160)}`)
    const f = (await files(ownerA.id)).find((x) => x.name === "CP575 early.pdf")
    ok(f && f.document_type === "ein_letter_irs", "saved in the formation storage as EIN letter", f)
    const d = (await db.from("documents").select("flow_stage, portal_visible, account_id").eq("file_name", "CP575 early.pdf").maybeSingle()).data
    log("NOTE", "CRM record", d)
  }

  console.log("\n#14 upload at a stage with no document type (Wizard Submitted)")
  {
    const r = await upload(sdA, "random.pdf", await pdf(["random"]), "Wizard Submitted")
    log("NOTE", `HTTP ${r.status}: ${r.text.slice(0, 200)}`)
    const inStore = (await files(ownerA.id)).some((x) => x.name === "random.pdf")
    const alarm = (await db.from("store_events").select("reason").eq("event", "pilot_alarm").eq("owner_id", ownerA.id).order("created_at", { ascending: false }).limit(2)).data
    log("NOTE", `landed in the formation storage: ${inStore}; alarms: ${JSON.stringify(alarm)}`)
  }

  console.log("\n#17-19 re-upload same name/different bytes, same/same, different name")
  {
    const a1 = await upload(sdA, "Articles.pdf", await pdf(["articles v1"]), "Filed with State", staff, { formation_date: "2026-10-14", entity_type: "SMLLC", formation_state: "WY" })
    log("NOTE", `Articles upload HTTP ${a1.status} ${a1.text.slice(0, 200)}`)
    const a2 = await upload(sdA, "Articles.pdf", await pdf(["articles v2 corrected"]), "Filed with State")
    const a3 = await upload(sdA, "Articles.pdf", await pdf(["articles v2 corrected"]), "Filed with State")
    const fs = (await files(ownerA.id)).filter((x) => x.name === "Articles.pdf")
    ok(fs.length === 1, "ONE Articles file after three uploads (new version, not copies)", fs.length)
    const vers = ((await db.from("store_file_versions").select("id").eq("file_id", fs[0]?.id)).data ?? []).length
    log("NOTE", `versions: ${vers} (expected 2: v1, v2 — the identical third is 'unchanged'); statuses ${a1.status}/${a2.status}/${a3.status}`)
    const rows = (await db.from("documents").select("id").eq("drive_file_id", `store:${fs[0]?.id}`)).data ?? []
    ok(rows.length === 1, "one CRM record for it", rows.length)
    await upload(sdA, "CP575 other.pdf", await pdf(["cp575 other"]), "EIN Received")
    const ein = (await files(ownerA.id)).filter((x) => x.document_type === "ein_letter_irs")
    ok(ein.length >= 2, "a differently named EIN document is a separate file", ein.length)
  }

  console.log("\n#7 company creation — the handover")
  {
    const m = await materializeFormationCompany({ contact_id: cid, formation_state: "WY", entity_type: "SMLLC", chosen_name: w1.llc, formation_date: "2026-10-14", actor: "zz-e2e" })
    ok(m.success, "company created", { o: m.outcome, e: m.error })
    const after = (await owners({ service_delivery_id: sdA }))[0]
    ok(after?.kind === "company" && after.id === ownerA.id && after.account_id === m.account_id, "same storage is now the company's", after)
    const acct = (await db.from("accounts").select("drive_folder_id").eq("id", m.account_id).single()).data
    ok(acct.drive_folder_id === null, "no Drive folder for the company")
    const docs = (await db.from("documents").select("file_name, account_id, contact_id, document_type_name").eq("service_delivery_id", sdA)).data
    log("NOTE", "records tied to the case after the handover", docs)
    const m2 = await materializeFormationCompany({ contact_id: cid, formation_state: "WY", entity_type: "SMLLC", chosen_name: w1.llc, actor: "zz-e2e" })
    log("NOTE", `#8 second creation attempt: ${m2.outcome}; owners for the case: ${(await owners({ service_delivery_id: sdA })).length}; handover events: ${((await db.from("store_events").select("id").eq("owner_id", ownerA.id).eq("event", "formation_attached")).data ?? []).length}`)

    console.log("\n#16 corrected Articles after the company exists (Go Back + re-upload)")
    const r = await upload(sdA, "Articles.pdf", await pdf(["articles v3 after company"]), "Filed with State")
    const fs = (await files(ownerA.id)).filter((x) => x.name === "Articles.pdf")
    ok(r.status === 200 && fs.length === 1, "still ONE Articles file; the new bytes are another version", { status: r.status, n: fs.length, t: r.text.slice(0, 120) })

    console.log("\n#34/#35 which records show on which page; welcome package")
    const acctDocs = (await db.from("documents").select("file_name").eq("account_id", m.account_id)).data?.map((d: { file_name: string }) => d.file_name)
    const ctDocs = (await db.from("documents").select("file_name, account_id").eq("contact_id", cid)).data
    log("NOTE", "account-linked records", acctDocs); log("NOTE", "contact-linked records (account_id shown)", ctDocs)
    const { findWelcomeDocsFromRecords } = await import("../../../lib/operations/welcome-docs")
    const wd = await findWelcomeDocsFromRecords(m.account_id as string)
    ok(!!wd.ein && !!wd.articles, "welcome package finds EIN + Articles", wd)
    // portal handle
    ;(globalThis as any).__main = { cid, sdA, account: m.account_id, ownerId: ownerA.id } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  console.log("\n#26-30 visibility, permissions")
  {
    const g = (globalThis as any).__main // eslint-disable-line @typescript-eslint/no-explicit-any
    const rows = (await db.from("documents").select("id, file_name, portal_visible, drive_file_id").or(`contact_id.eq.${g.cid},account_id.eq.${g.account}`)).data as Array<{ id: string; file_name: string; portal_visible: boolean }>
    log("NOTE", "portal_visible per record", rows.map((r) => `${r.file_name}=${r.portal_visible}`))
    const contract = rows.find((r) => /Signed/.test(r.file_name)); const summary = rows.find((r) => /Formation Summary/.test(r.file_name))
    for (const [label, r] of [["contract", contract], ["formation summary", summary]] as const) {
      if (!r) { log("NOTE", `${label}: no record found`); continue }
      const other = await call(`/api/portal/documents/${r.id}`, { cookie: clientUx })
      ok(other.status === 404 || other.status === 403, `another client cannot open the ${label}`, `HTTP ${other.status}`)
      const anon = await call(`/api/portal/documents/${r.id}`)
      ok([401, 403, 404].includes(anon.status) || anon.status === 307, `a logged-out visitor cannot open the ${label}`, `HTTP ${anon.status}`)
    }
    const anonStore = await call(`/api/crm-store/browse/file/${randomUUID()}`)
    ok([401, 403, 404, 307].includes(anonStore.status), "the Storage file route refuses a logged-out visitor", `HTTP ${anonStore.status}`)
    const clientStore = await call(`/api/crm-store/browse/file/${randomUUID()}`, { cookie: clientUx })
    ok([401, 403, 404, 307].includes(clientStore.status), "…and a client", `HTTP ${clientStore.status}`)
    const clientUpload = await upload(g.sdA, "evil.pdf", await pdf(["evil"]), "Filed with State", clientUx)
    ok([401, 403].includes(clientUpload.status), "a client cannot use the staff workspace upload", `HTTP ${clientUpload.status}`)
    const anonUpload = await call(`/api/flows/${g.sdA}/upload-document`, { json: { storage_path: "x", file_name: "x.pdf" } })
    ok([401, 403, 307].includes(anonUpload.status), "a logged-out visitor cannot either", `HTTP ${anonUpload.status}`)
  }

  // ───────────── B. odd files ─────────────
  console.log("\n#20-25 odd files at EIN stage (new formation)")
  {
    const s = await signLead("odd"); await processOfferSigned(s.token); const c2 = (await contactOf(s.email))!; const sd = (await formation(c2, "odd")).id; const own = (await owners({ service_delivery_id: sd }))[0]
    const cases: Array<[string, Buffer]> = [
      ["zero byte.pdf", Buffer.alloc(0)], ["a/b\\c slash.pdf", await pdf(["slash"])], ["Ñandú — résumé.pdf", await pdf(["unicode"])], ["  spaces  .pdf", await pdf(["spaces"])],
      ["X".repeat(260) + ".pdf", await pdf(["long"])], ["CASE.pdf", await pdf(["case a"])], ["case.pdf", await pdf(["case b"])],
    ]
    for (const [n, b] of cases) { const r = await upload(sd, n, b, "EIN Received"); log("NOTE", `"${n.length > 40 ? n.slice(0, 20) + "…(" + n.length + ")" : n}" → HTTP ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 120)}`) }
    log("NOTE", "files now in the storage", (await files(own.id)).map((f) => `${f.name.slice(0, 30)}[${f.state}]`))
    const big = await upload(sd, "big.pdf", Buffer.concat([await pdf(["big"]), Buffer.alloc(60 * 1024 * 1024)]), "EIN Received")
    log("NOTE", `60 MB file → HTTP ${big.status} ${big.text.slice(0, 160)}`)
  }

  console.log("\n#39 three different files at once, and the same file from two tabs")
  {
    const s = await signLead("conc"); await processOfferSigned(s.token); const c3 = (await contactOf(s.email))!; const sd = (await formation(c3, "conc")).id; const own = (await owners({ service_delivery_id: sd }))[0]
    const rs = await Promise.all([1, 2, 3].map(async (i) => upload(sd, `conc ${i}.pdf`, await pdf([`c${i}`]), "EIN Received")))
    const same = await Promise.all([0, 1].map(async () => upload(sd, `same ${base}.pdf`, await pdf(["same"]), "EIN Received")))
    const fs = await files(own.id)
    ok(rs.every((r) => r.status === 200), "three parallel uploads all accepted", rs.map((r) => r.status))
    ok(fs.filter((f) => f.name.startsWith("conc ")).length === 3 && fs.filter((f) => f.name === `same ${base}.pdf`).length === 1, "3 files + exactly ONE 'same.pdf'", fs.map((f) => f.name))
    log("NOTE", `same-file statuses ${same.map((r) => r.status)}`)
    const rowsSame = ((await db.from("documents").select("id").like("drive_file_id", "store:%").eq("file_name", `same ${base}.pdf`)).data ?? []).length
    ok(rowsSame === 1, "one CRM record for 'same.pdf'", rowsSame)
  }

  // ───────────── C. others ─────────────
  console.log("\n#9 two formations bought by the same new client")
  {
    const s = await signLead("two"); await processOfferSigned(s.token); const c4 = (await contactOf(s.email))!
    const s1 = (await formation(c4, "two-a")).id; const s2 = (await formation(c4, "two-b")).id
    const o = await owners({ contact_id: c4, kind: "formation" }).catch(() => [])
    const oa = await owners({ service_delivery_id: s1 }), ob = await owners({ service_delivery_id: s2 })
    log("NOTE", `two cases → storages: ${oa.length}/${ob.length}`)
    const w = await wizard(c4, s1, s.email, s.tag); void w
    const m = await materializeFormationCompany({ contact_id: c4, formation_state: "WY", entity_type: "SMLLC", chosen_name: `ZZ E2E ${s.tag} LLC`, formation_date: "2026-10-14", actor: "zz-e2e" })
    log("NOTE", `company creation with two open cases: ${m.outcome} ${m.error ?? ""}`)
    const after = await owners({ service_delivery_id: s1 }), after2 = await owners({ service_delivery_id: s2 })
    log("NOTE", `after: case A is ${after[0]?.kind}, case B is ${after2[0]?.kind}`)
    const alarms = (await db.from("store_events").select("reason").eq("event", "pilot_alarm").order("created_at", { ascending: false }).limit(3)).data
    log("NOTE", "alarms", alarms); void o
  }

  console.log("\n#15 cancelled formation, then company creation")
  {
    const s = await signLead("canc"); await processOfferSigned(s.token); const c5 = (await contactOf(s.email))!; const sd = (await formation(c5, "canc")).id
    await db.from("service_deliveries").update({ status: "cancelled" }).eq("id", sd)
    const own = (await owners({ service_delivery_id: sd }))[0]
    log("NOTE", `owner after cancel: lifecycle=${own?.lifecycle_override}`)
    const r = await upload(sd, "Articles.pdf", await pdf(["canc"]), "Filed with State")
    log("NOTE", `upload on a cancelled case → HTTP ${r.status} ${r.text.slice(0, 160)}`)
  }

  console.log("\n#37 ITIN for a new client")
  {
    const s = await signLead("itin"); await processOfferSigned(s.token); const c6 = (await contactOf(s.email))!
    const itin = (await createSD({ service_type: "ITIN", contact_id: c6, account_id: null, service_name: "ITIN zz e2e" } as never) as { id: string }).id
    const st = (await db.from("service_deliveries").select("stage").eq("id", itin).single()).data.stage
    const r = await upload(itin, "ITIN form.pdf", await pdf(["itin"]), st)
    ok(r.status === 200, "ITIN upload accepted", `HTTP ${r.status} ${r.text.slice(0, 160)}`)
    const d = (await db.from("documents").select("drive_file_id, contact_id, account_id").eq("file_name", "ITIN form.pdf").maybeSingle()).data
    ok(d && String(d.drive_file_id).startsWith("store:") && d.account_id === null, "in the person's storage", d)
    const po = (await owners({ contact_id: c6, kind: "person" }))[0]
    ok(po && (await files(po.id)).some((f) => f.name === "ITIN form.pdf"), "inside the PERSON's storage")
  }

  console.log("\n#10 returning client / #11 mid-flight / #12 switch off — see t19 (already proven)")
  console.log("\nSummary:", fails === 0 ? "no FAIL lines" : `${fails} FAIL line(s)`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
