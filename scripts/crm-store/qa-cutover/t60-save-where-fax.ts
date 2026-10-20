/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Save-where pop-up, Fax tool (dev job c43a8b2e) — SANDBOX proof that each kind of destination lands where it should, through the
 * REAL checks and the REAL storage writer (the same functions the Fax send route calls). SANDBOX only.
 *
 * What is a STAND-IN: the sandbox refuses real faxes by design (`sendFax` → FaxRefusedOutsideProductionError — NOT weakened here), so the
 * send route cannot reach its "file it after a successful send" step in the sandbox. Like the old t43 this script therefore calls the
 * functions the route calls after the send (`resolveProposal`, `validateDestination`, `saveToDestination`) directly. The route's own
 * order (check → send → file) is proven by tests/unit/fax-send-route-save-where.test.ts with an injected `sendFax`.
 *
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t60-save-where-fax.ts
 */
import { config } from "dotenv"
import { createHash } from "crypto"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as any
  const { COMPANY_TEMPLATE, storeSafeFolderName, ensurePersonOwner } = await import("../../../lib/crm-store/formation-pilot")
  const D = await import("../../../lib/crm-store/save-destination")
  const W = await import("../../../lib/crm-store/save-where")
  const { NO_STORAGE_REASON_SENTENCE } = await import("../../../lib/crm-store/no-storage")
  const stamp = Date.now()
  const rpc = (f: string, a: unknown) => sb.rpc(f, a) as Promise<{ data: any; error: { message: string } | null }>
  const created: { accounts: string[]; owners: string[]; contacts: string[]; files: string[] } = { accounts: [], owners: [], contacts: [], files: [] }

  const mkAcc = async (label: string, status = "Active", withStorage = true) => {
    const { data, error } = await sb.from("accounts").insert({ company_name: `QA SaveWhere ${label} ${stamp} LLC`, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status }).select("id, company_name").single()
    if (error) throw new Error(error.message)
    created.accounts.push(data.id)
    if (!withStorage) return { ...data, ownerId: null as string | null }
    const { data: ownerId, error: oErr } = await rpc("store_ensure_owner", { p_kind: "company", p_ref: data.id })
    if (oErr) throw new Error(oErr.message)
    await rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(data.company_name) })
    created.owners.push(ownerId)
    return { ...data, ownerId: ownerId as string }
  }
  const A = await mkAcc("A")
  const B = await mkAcc("B-closed-nostorage", "Cancelled", false)
  const C = await mkAcc("C-open-nostorage", "Active", false)
  const E = await mkAcc("E-study")
  const login = { id: null as string | null, ownerOnly: true }
  const bytes = (s: string) => Buffer.from(`%PDF-1.4 ${s} ${stamp}`)
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

  /** the whole chain the route runs for a "Save here" choice */
  const runChoice = async (choice: any, uploadName: string, b: Buffer) => {
    const v = await D.validateDestination(choice, D.realDestinationDeps(login), uploadName)
    if (!v.decision.ok) return { ok: false as const, error: v.decision.error }
    const filed = await D.saveToDestination(choice, v.owner!, { bytes: b, mimeType: "application/pdf", sha256: sha(b), actor: null, unlinked: !!v.decision.unlinked, finalName: v.finalName, periodYear: choice.purpose === "irs_tax_return" ? W.taxYearFromName(v.finalName) : null }, D.realFileDeps())
    created.files.push(filed.fileId)
    return { ok: true as const, filed }
  }
  const propose = async (purpose: any, company: any, fileName: string) => D.resolveProposal(W.proposeFaxPlace({ purpose, company, fileName }), D.realResolveDeps()) as Promise<any>
  const asChoice = (p: any, purpose: any, fileName: string) => ({ mode: "save", purpose, ownerId: p.ownerId, folderId: p.folderId, newFolderName: p.newFolderName, fileName })
  const fileRow = async (fileId: string) => (await sb.from("store_files").select("name, document_type, folder_id, period_year, published, owner_id").eq("id", fileId).single()).data
  const docRow = async (fileId: string) => (await sb.from("documents").select("id, account_id, contact_id, portal_visible, document_type_name").eq("drive_file_id", `store:${fileId}`)).data ?? []

  try {
    // ── (a) tax return → Tax › year (the year folder is made on the spot)
    const compA = { kind: "company", accountId: A.id, name: A.company_name }
    const p1 = await propose("irs_tax_return", compA, `2025 Tax Return - ${A.company_name}.pdf`)
    check("S1 tax return → proposed in the company's Tax folder with the year 2025 to make", p1.state === "proposed" && p1.ownerId === A.ownerId && p1.newFolderName === "2025" && /3\. Tax › 2025$/.test(p1.path), JSON.stringify(p1))
    const b1 = bytes("return")
    const r1 = await runChoice(asChoice(p1, "irs_tax_return", `2025 Tax Return - ${A.company_name}`), `signed.pdf`, b1)
    check("S2 …and it is filed there", r1.ok && /Tax › 2025$/.test((r1 as any).filed.path), JSON.stringify(r1))
    const f1 = await fileRow((r1 as any).filed.fileId)
    const { data: yf } = await sb.from("store_folders").select("name, kind, parent_id").eq("id", f1.folder_id).single()
    check("S3 the year folder is a tax-year folder, the file is typed irs_fax, year 2025, not published", yf.name === "2025" && yf.kind === "tax_year" && f1.document_type === "irs_fax" && f1.period_year === 2025 && f1.published === false, JSON.stringify({ yf, f1 }))
    const d1 = await docRow((r1 as any).filed.fileId)
    check("S4 listed against the company, hidden from the client, labelled IRS Fax", d1.length === 1 && d1[0].account_id === A.id && d1[0].portal_visible === false && d1[0].document_type_name === "IRS Fax", JSON.stringify(d1))
    const r1b = await runChoice(asChoice(p1, "irs_tax_return", `2025 Tax Return - ${A.company_name}`), `signed.pdf`, b1)
    check("S5 the SAME file again = the same file, ONE row", r1b.ok && (r1b as any).filed.fileId === (r1 as any).filed.fileId && (r1b as any).filed.write === "unchanged" && (await docRow((r1 as any).filed.fileId)).length === 1, JSON.stringify(r1b))
    const p1b = await propose("irs_tax_return", compA, `2025 Tax Return - ${A.company_name}.pdf`)
    check("S6 the second proposal finds the existing 2025 folder (nothing new to make)", p1b.newFolderName === null && p1b.folderId === f1.folder_id, JSON.stringify(p1b))
    const r1c = await runChoice(asChoice(p1b, "irs_tax_return", `2025 Tax Return - ${A.company_name}`), "x.pdf", bytes("different"))
    check("S7 a DIFFERENT file with the same name is a second file (the writer's ' (2)')", r1c.ok && (r1c as any).filed.fileId !== (r1 as any).filed.fileId && /\(2\)/.test((r1c as any).filed.name), JSON.stringify(r1c))

    // ── (b) EIN request → the company's own folder
    const p2 = await propose("irs_ein_request", compA, "EIN request.pdf")
    check("S8 EIN request → the company's own folder (1. Company)", p2.state === "proposed" && p2.ownerId === A.ownerId && /1\. Company$/.test(p2.path) && p2.newFolderName === null, JSON.stringify(p2))
    const r2 = await runChoice(asChoice(p2, "irs_ein_request", "EIN request"), "EIN request.pdf", bytes("ein"))
    const f2 = await fileRow((r2 as any).filed.fileId)
    check("S9 filed, typed irs_fax", r2.ok && f2.folder_id === p2.folderId && f2.document_type === "irs_fax", JSON.stringify(r2))

    // ── (c) third party → Business › Fax (made on the spot), no CRM row
    const p3 = await propose("third_party", null, "fax.pdf")
    check("S10 third party → Business › Fax", p3.state === "proposed" && /^Business/.test(p3.path) && /Fax$/.test(p3.path), JSON.stringify(p3))
    const r3 = await runChoice(asChoice(p3, "third_party", `QA SaveWhere third party ${stamp}`), "fax.pdf", bytes("third"))
    const f3 = await fileRow((r3 as any).filed.fileId)
    const { data: bo } = await sb.from("store_owners").select("kind").eq("id", f3.owner_id).single()
    check("S11 saved in the Business area, untyped, and NO CRM documents row (nobody outside the firm sees it)", r3.ok && bo.kind === "business" && f3.document_type === null && (await docRow((r3 as any).filed.fileId)).length === 0 && (r3 as any).filed.documentRowId === null, JSON.stringify({ r3, f3 }))
    const p3b = await propose("third_party", null, "fax.pdf")
    check("S12 next time the Fax folder exists (nothing to make)", p3b.newFolderName === null && !!p3b.folderId, JSON.stringify(p3b))

    // ── 'Something else' / Not sure
    const p4 = await propose("something_else", compA, "x.pdf")
    const p5 = await propose("irs_tax_return", null, `${A.company_name} 2025.pdf`)
    check("S13 'Something else' and 'IRS fax with no company' propose NOTHING (no guessing from the name)", p4.state === "choose" && p5.state === "choose", JSON.stringify({ p4, p5 }))

    // ── Change place: anywhere (another company's folder, a person's storage, My files)
    const { data: corr } = await sb.from("store_folders").select("id").eq("owner_id", A.ownerId).eq("kind", "correspondence").is("trashed_at", null).limit(1)
    const r6 = await runChoice({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: A.ownerId, folderId: corr![0].id, newFolderName: null, fileName: "Letter" }, "letter.pdf", bytes("corr"))
    check("S14 Change place: any folder of a company (Correspondence); type 'Other document'", r6.ok && (await fileRow((r6 as any).filed.fileId)).document_type === "other_document", JSON.stringify(r6))
    const ct = await sb.from("contacts").insert({ full_name: `QA SaveWhere Person ${stamp}`, email: `qa-savewhere-${stamp}@example.com` }).select("id").single()
    if (ct.error) throw new Error(ct.error.message)
    created.contacts.push(ct.data.id)
    const personOwner = await ensurePersonOwner(ct.data.id, `QA SaveWhere Person ${stamp}`)
    created.owners.push(personOwner)
    const { data: pfold } = await sb.from("store_folders").select("id, kind").eq("owner_id", personOwner).is("trashed_at", null).neq("kind", "root")
    const pf = (pfold ?? [])[0]
    const r7 = await runChoice({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: personOwner, folderId: pf.id, newFolderName: null, fileName: "Note" }, "note.pdf", bytes("person"))
    check("S15 Change place: a person's storage", r7.ok && (await docRow((r7 as any).filed.fileId))[0]?.contact_id === ct.data.id, JSON.stringify(r7))
    const r8 = await runChoice({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: personOwner, folderId: pf.id, newFolderName: null, fileName: "x" }, "Passport copy.pdf", bytes("pp"))
    check("S16 a passport is refused for a person's / company's storage (plain sentence)", !r8.ok && /person's own paper/.test((r8 as any).error), JSON.stringify(r8))
    // "My files": a login's own private area (the sandbox has no primary-owner login, so the area of an existing login is used)
    const { data: pa } = await sb.from("store_owners").select("id, private_user_id").eq("kind", "private").not("private_user_id", "is", null).limit(1)
    const myFiles = pa![0].id as string
    login.id = pa![0].private_user_id as string; login.ownerOnly = false
    const { data: mtop } = await sb.from("store_folders").select("id").eq("owner_id", myFiles).is("parent_id", null).limit(1)
    const r9 = await runChoice({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: myFiles, folderId: mtop![0].id, newFolderName: `QA SaveWhere ${stamp}`, fileName: "Mine" }, "mine.pdf", bytes("mine"))
    check("S17 Change place: My files, with a new folder made on the spot (its own login)", r9.ok && (await docRow((r9 as any).filed.fileId)).length === 0, JSON.stringify(r9))
    const r9b = await D.validateDestination({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: myFiles, folderId: mtop![0].id, newFolderName: "x", fileName: "Mine" }, D.realDestinationDeps({ id: "00000000-0000-4000-8000-0000000000ff", ownerOnly: false }), "mine.pdf")
    check("S18 another login cannot save into someone else's My files", !r9b.decision.ok, JSON.stringify(r9b.decision))

    // ── personal papers
    const r10 = await runChoice(asChoice(p2, "irs_ein_request", "SS-4 request"), "SS-4 request.pdf", bytes("ss4"))
    check("S19 an SS-4 is filed where chosen but listed against NO company", r10.ok && (await docRow((r10 as any).filed.fileId))[0]?.account_id === null, JSON.stringify(r10))
    const r10b = await runChoice(asChoice(p2, "irs_ein_request", "plain name"), "Passport.pdf", bytes("pp2"))
    check("S20 renaming a passport does not get it past the check", !r10b.ok, JSON.stringify(r10b))

    // ── refusals
    const pB = await propose("irs_tax_return", { kind: "company", accountId: B.id, name: B.company_name }, "2025.pdf")
    check("S21 a CLOSED company with no storage → refused, the plain sentence (archived)", pB.state === "refused" && pB.why === NO_STORAGE_REASON_SENTENCE.archived, JSON.stringify(pB))
    const pC = await propose("irs_ein_request", { kind: "company", accountId: C.id, name: C.company_name }, "x.pdf")
    check("S22 an open company with no storage and no folder → refused (no_folder)", pC.state === "refused" && pC.why === NO_STORAGE_REASON_SENTENCE.no_folder, JSON.stringify(pC))
    const wrong = await D.validateDestination({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: A.ownerId!, folderId: p3b.folderId, newFolderName: null, fileName: "x" }, D.realDestinationDeps(login), "x.pdf")
    check("S23 WRONG OWNER: a Business folder with the company as owner → refused", !wrong.decision.ok && /not in the place you chose/.test(wrong.decision.error ?? ""), JSON.stringify(wrong.decision))
    const { data: tmpF } = await sb.from("store_folders").insert({ owner_id: A.ownerId, parent_id: corr![0].id, kind: "custom", name: `QA trashed ${stamp}`, trashed_at: new Date().toISOString() }).select("id").single()
    const tr = await D.validateDestination({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: A.ownerId!, folderId: tmpF.id, newFolderName: null, fileName: "x" }, D.realDestinationDeps(login), "x.pdf")
    check("S24 a TRASHED folder → refused", !tr.decision.ok && /trash/.test(tr.decision.error ?? ""), JSON.stringify(tr.decision))
    await sb.from("store_owners").update({ study_only: true }).eq("id", E.ownerId)
    const { data: ef } = await sb.from("store_folders").select("id").eq("owner_id", E.ownerId).eq("kind", "tax").is("trashed_at", null).limit(1)
    const st = await D.validateDestination({ proposalOf: null, mode: "save", purpose: "irs_tax_return", ownerId: E.ownerId!, folderId: ef![0].id, newFolderName: null, fileName: "x" }, D.realDestinationDeps(login), "x.pdf")
    check("S25 a STUDY-ONLY company (Drive-only) → refused with the no-storage sentence", !st.decision.ok && st.decision.error === NO_STORAGE_REASON_SENTENCE.no_folder, JSON.stringify(st.decision))
    const root = (await sb.from("store_folders").select("id").eq("owner_id", A.ownerId).is("parent_id", null).limit(1)).data![0].id
    const rt = await D.validateDestination({ proposalOf: null, mode: "save", purpose: "something_else", ownerId: A.ownerId!, folderId: root, newFolderName: null, fileName: "x" }, D.realDestinationDeps(login), "x.pdf")
    check("S26 the top folder of a client takes no file", !rt.decision.ok, JSON.stringify(rt.decision))
    const filesAfter = (await sb.from("store_files").select("id").eq("owner_id", E.ownerId)).data ?? []
    check("S27 nothing was written for the refused places", filesAfter.length === 0)
  } finally {
    for (const id of created.files) { try { await rpc("store_trash_file", { p_file_id: id, p_actor: null, p_reason: "QA t60 clean-up" }) } catch { /* best effort */ } }
    for (const id of created.owners) await sb.from("store_owners").update({ study_only: true }).eq("id", id)
    for (const id of created.accounts) await sb.from("accounts").update({ status: "Cancelled" }).eq("id", id)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
