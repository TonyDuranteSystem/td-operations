/* eslint-disable no-console, no-restricted-syntax -- sandbox QA script: prints its results and builds throw-away fixture rows directly */
/**
 * Stop Drive S2 (dev job 264bb882) — SANDBOX ONLY, REAL TEST Shared Drive: every former Drive writer is tried against the kinds of company
 * that used to be written to in Drive (a company "left on Drive" = REBIS / YBR / Degasper / Fresh Legal shape, and a Closed company),
 * each with a REAL folder in the test Drive, and the number of Drive WRITE requests that left the process must be ZERO.
 *
 * A spy on `fetch` counts every Drive API request that is not a read. Two controls prove the spy works: a Drive READ is counted as a read, and
 * ONE deliberate write made inside the backup scope (the only way through) is counted as exactly one write — everything before it is 0.
 *
 * Run: GOOGLE_DRIVE_LIVE=1 GOOGLE_SHARED_DRIVE_ID=<test drive> npx tsx scripts/crm-store/qa-cutover/t49-stop-drive-s2-no-writers.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })

const writes: Array<{ method: string; url: string }> = []
let reads = 0
function installSpy() {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    if (/googleapis\.com\/(upload\/)?drive\/v3/.test(url) || /upload_id=/.test(url)) {
      if (method === "GET" || method === "HEAD") reads++
      else writes.push({ method, url: url.replace(/\?.*/, "") })
    }
    return real(input as never, init)
  }) as typeof fetch
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("sandbox only: refusing to run")
  if (process.env.GOOGLE_DRIVE_LIVE !== "1") throw new Error("run with GOOGLE_DRIVE_LIVE=1 and the TEST Shared Drive in GOOGLE_SHARED_DRIVE_ID")
  const testDrive = (process.env.GOOGLE_SHARED_DRIVE_ID ?? "").trim()
  if (!testDrive || testDrive === "0AOLZHXSfKUMHUk9PVA") throw new Error("GOOGLE_SHARED_DRIVE_ID must be the TEST Shared Drive")
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)?.slice(0, 400)) }

  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const drive = await (await import("../_drive-fixture")).driveFixture()
  const realDrive = await import("../../../lib/google-drive")
  const { DriveWritesStoppedError } = await import("../../../lib/google-drive-write-scope")
  installSpy()

  const stamp = Date.now()
  const made: string[] = []
  const mk = async (parent: string, name: string) => { const f = await drive.createFolder(parent, name); made.push(f.id as string); return f.id as string }
  const attempt = async (fn: () => Promise<unknown>) => { try { return { ok: true as const, value: await fn() } } catch (e) { return { ok: false as const, error: e as Error } } }

  // two throw-away companies with a real folder each and NO storage: one "left on Drive", one Closed
  const folderF = await mk(testDrive, `QA Test S2 frozen company ${stamp}`)
  const folderC = await mk(testDrive, `QA Test S2 closed company ${stamp}`)
  const subF = await mk(folderF, "1. Company")
  const base = { state_of_formation: "Wyoming", entity_type: "Single Member LLC" }
  const { data: F, error: fErr } = await sb.from("accounts").insert({ ...base, company_name: `QA S2 frozen ${stamp} LLC`, status: "Offboarding", drive_folder_id: folderF, ra_renewal_date: "2026-11-01" }).select("id").single()
  if (fErr) throw new Error(`fixture: ${fErr.message}`)
  const { data: C, error: cErr } = await sb.from("accounts").insert({ ...base, company_name: `QA S2 closed ${stamp} LLC`, status: "Closed", drive_folder_id: folderC }).select("id").single()
  if (cErr) throw new Error(`fixture: ${cErr.message}`)
  const setupWrites = writes.length // the fixture folders above (made through the backup-scoped fixture handle)
  const pdf = Buffer.from("%PDF-1.4\n% QA Test S2\n%%EOF")

  try {
    // ── A. the sixteen Drive client verbs, aimed at the REAL folders ──────────────────────────────────────────
    const verbs: Array<[string, () => Promise<unknown>]> = [
      ["uploadFile", () => realDrive.uploadFile(folderF, "x.txt", "x")],
      ["updateFileContent", () => realDrive.updateFileContent(subF, "x")],
      ["renameFile", () => realDrive.renameFile(subF, "renamed")],
      ["createFolder", () => realDrive.createFolder(folderF, "new")],
      ["moveFile", () => realDrive.moveFile(subF, folderC)],
      ["createFolderMyDrive", () => realDrive.createFolderMyDrive(folderF, "new")],
      ["uploadFileMyDrive", () => realDrive.uploadFileMyDrive(folderF, "x.txt", "x")],
      ["ensureDrivePath", () => realDrive.ensureDrivePath(folderF, ["Compliance"])],
      ["uploadBinaryToDrive", () => realDrive.uploadBinaryToDrive("x.pdf", pdf, "application/pdf", folderF)],
      ["uploadBinaryToDriveUpsert", () => realDrive.uploadBinaryToDriveUpsert("x.pdf", pdf, "application/pdf", folderF, new Map())],
      ["updateBinaryFile", () => realDrive.updateBinaryFile(subF, pdf, "application/pdf")],
      ["trashFile", () => realDrive.trashFile(subF)],
      ["findOrCreateYearFolder", () => realDrive.findOrCreateYearFolder(folderF, 2025)],
      ["createTaggedFolder", () => realDrive.createTaggedFolder(folderF, "tagged", { k: "v" })],
      ["patchTaggedItem", () => realDrive.patchTaggedItem(subF, { name: "renamed" })],
      ["uploadStreamToDrive", () => realDrive.uploadStreamToDrive({ mode: "create", parentId: folderF, name: "s.bin", mimeType: "application/octet-stream", size: 3, stream: new Blob([new Uint8Array(3)]).stream(), appProperties: { k: "v" } })],
    ]
    let refused = 0
    for (const [, run] of verbs) { const r = await attempt(run); if (!r.ok && r.error instanceof DriveWritesStoppedError) refused++ }
    ck(`A1 all ${verbs.length} Drive client verbs refuse a write into a real company folder`, refused === verbs.length, { refused })
    ck("A2 not one Drive write request left the process", writes.length === setupWrites, writes.slice(setupWrites))

    // ── B. the former writers, library level ──────────────────────────────────────────────────────────────────
    const { ensureCompanyFolder } = await import("../../../lib/drive-folder-utils")
    const r1 = await attempt(() => ensureCompanyFolder(F.id, "QA S2 frozen LLC", "Wyoming"))
    ck("B1 ensureCompanyFolder (company left on Drive): refused as 'frozen', no folder handed back", !r1.ok && (r1.error as Error & { reason?: string }).reason === "frozen", r1)
    const r2 = await attempt(() => ensureCompanyFolder(C.id, "QA S2 closed LLC", "Wyoming"))
    ck("B2 ensureCompanyFolder (Closed company): refused as 'archived'", !r2.ok && (r2.error as Error & { reason?: string }).reason === "archived", r2)

    const { saveFormToDrive } = await import("../../../lib/form-to-drive")
    const meta = { token: `qa-s2-${stamp}`, submittedAt: new Date().toISOString(), companyName: "QA S2 frozen LLC", year: 2025 }
    const r3 = await saveFormToDrive("tax_return", { llc_name: "QA S2 frozen LLC" }, [], folderF, meta)
    ck("B3 saveFormToDrive into the company's real Drive folder: an error result, nothing filed", r3.summaryFileId === null && r3.errors.length > 0 && r3.copied.length === 0, r3)

    const { saveFormForAccount } = await import("../../../lib/crm-store/save-account-form")
    const r4 = await saveFormForAccount({ accountId: F.id, formType: "tax_return", submittedData: { llc_name: "x" }, uploadPaths: [], meta })
    ck("B4 saveFormForAccount (company left on Drive): filed nowhere ({route:'none'})", r4.route === "none", r4)

    const { fileRenewal } = await import("../../../lib/operations/file-renewal")
    const r5 = await fileRenewal({ account_id: F.id, delivery_id: null, kind: "ra", filed_date: "2026-10-19", receipt: { file_name: "r.pdf", mime_type: "application/pdf", data: pdf } })
    const { data: after } = await sb.from("accounts").select("ra_renewal_date").eq("id", F.id).single()
    ck("B5 fileRenewal (Calendar 'Mark filed') for a company left on Drive: fails with a plain sentence BEFORE anything changes", r5.success === false && /read-only/.test(String(r5.error)) && after.ra_renewal_date === "2026-11-01", { r5, after })

    const { saveSignedGeneratedDocument } = await import("../../../lib/portal/save-generated-document")
    const r6 = await saveSignedGeneratedDocument({ accountId: F.id, contactId: null, fileBuffer: pdf, fileName: "QA S2 doc.pdf", documentType: "Other", category: 1 } as never)
    ck("B6 saveSignedGeneratedDocument (company left on Drive): refused with the sentence", r6.success === false && (r6 as { refused?: boolean }).refused === true, r6)

    const { saveDocumentForAccount } = await import("../../../lib/crm-store/save-for-account")
    const r7 = await saveDocumentForAccount({ accountId: F.id, name: "x.pdf", bytes: pdf, mimeType: "application/pdf", folder: "company", documentType: null, callerKey: `qa-s2:${stamp}` })
    ck("B7 saveDocumentForAccount (company left on Drive): answers 'drive' = nothing saved, no write", r7.route === "drive", r7)

    ck("B8 STILL not one Drive write request after every former writer was tried", writes.length === setupWrites, writes.slice(setupWrites))

    // ── C. controls: the spy sees reads, and sees exactly the one deliberate write made inside the backup scope ───
    const readsBefore = reads
    await realDrive.listFolder(folderF, 10)
    ck("C1 control: a Drive READ of the same folder works and the spy counts it", reads > readsBefore)
    const before = writes.length
    const { runAsStoreBackup } = await import("../../../lib/google-drive-write-scope")
    const probe = await runAsStoreBackup(() => realDrive.createFolder(folderF, "control-write-inside-backup-scope"))
    made.push(probe.id as string)
    ck("C2 control: ONE write inside the backup scope goes out and the spy counts exactly one", writes.length === before + 1 && before === setupWrites, { before, now: writes.length })
  } finally {
    await sb.from("accounts").delete().in("id", [F.id, C.id])
    for (const id of made.reverse()) await drive.trashFile(id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
