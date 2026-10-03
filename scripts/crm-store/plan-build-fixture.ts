/* eslint-disable no-restricted-syntax -- sandbox-only test fixture ("ZZ Plan Pilot" rows + a TEST-Drive folder), not business writes */
/**
 * Fixture for the PLAN-DRIVEN BUILD — SANDBOX + TEST Shared Drive only. A small company shaped like Prowave: a
 * document with its e-signature certificate (to merge), a DBA in its own folder, drafts that stay on Drive, a
 * member's personal papers, a personal letter, a 1099 that belongs to ANOTHER company, and one deliberately broken
 * certificate. Writes the plan (with real md5 / size) and its fingerprint next to this script's output.
 *   npx tsx --tsconfig tsconfig.json scripts/crm-store/plan-build-fixture.ts <out-dir>
 */
import { config } from "dotenv"
config({ path: ".env.local" })
import { createHash } from "crypto"
import { writeFileSync, mkdirSync } from "fs"
import { PDFDocument, StandardFonts } from "pdf-lib"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"

async function pdf(text: string, pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) d.addPage([612, 792]).drawText(`${text} — page ${i + 1}`, { x: 50, y: 740, size: 12, font: f })
  return Buffer.from(await d.save())
}
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex")

async function main() {
  const outDir = process.argv[2]
  if (!outDir) throw new Error("usage: plan-build-fixture.ts <out-dir>")
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(SANDBOX_REF)) throw new Error("not the sandbox — refusing")
  process.env.SANDBOX_MODE = "1"
  process.env.GOOGLE_DRIVE_LIVE = "1"
  process.env.GOOGLE_SHARED_DRIVE_ID = TEST_DRIVE
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const drive = await import("@/lib/google-drive")
  const day = new Date().toISOString().slice(0, 16).replace("T", " ")
  const mk = async (parent: string, name: string) => ((await drive.createFolder(parent, name)) as { id: string }).id
  const up = async (parent: string, name: string, bytes: Buffer, mime = "application/pdf") => ((await drive.uploadBinaryToDrive(name, bytes, mime, parent)) as { id: string }).id
  const insert = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await db.from(table).insert(row).select("id").single()
    if (error) throw new Error(`${table}: ${error.message}`)
    return data.id as string
  }

  const name = `ZZ Plan Pilot LLC ${day}`
  const otherName = `ZZ Plan Other LLC ${day}`
  const top = await mk(TEST_DRIVE, name)
  const company = await mk(top, "1. Company"), contacts = await mk(top, "2. Contacts"), tax = await mk(top, "3. Tax")
  const banking = await mk(top, "4. Banking"), corr = await mk(top, "5. Correspondence")
  const y2024 = await mk(tax, "2024"), dba = await mk(top, "DBA")
  const otherTop = await mk(TEST_DRIVE, otherName)

  const bytes = {
    articles: await pdf("ZZ Plan — Articles of Organization (test)"),
    oa: await pdf("ZZ Plan — Operating Agreement (test)", 2), oaCert: await pdf("ZZ Plan — signing certificate of the OA (test)"),
    dba: await pdf("ZZ Plan — DBA application, notarized (test)", 2), dbaCert: await pdf("ZZ Plan — signing certificate of the DBA (test)"),
    dbaDraft: await pdf("ZZ Plan — DBA application DRAFT (test)"),
    ret: await pdf("ZZ Plan — Form 1065 for 2024 (test)", 3), retCert: await pdf("ZZ Plan — signing certificate of the return (test)"),
    bank: await pdf("ZZ Plan — bank statement (test)"),
    passport: await pdf("ZZ Plan — passport of Paolo (test only)"),
    itin: await pdf("ZZ Plan — ITIN notice of Paolo (test only)"),
    letter: await pdf("ZZ Plan — a personal letter to Paolo (test only)"),
    k1099: await pdf("ZZ Plan — Form 1099 addressed to the OTHER company (test)"),
    brokenDoc: await pdf("ZZ Plan — a document whose certificate is broken (test)"),
    brokenCert: Buffer.from("this is not a pdf at all"),
    heldFile: await pdf("ZZ Plan — a file on hold (test)"),
  }
  const id = {
    articles: await up(company, "Articles.pdf", bytes.articles),
    oa: await up(company, "Operating Agreement.pdf", bytes.oa), oaCert: await up(corr, "Office Lease 4.pdf", bytes.oaCert),
    dba: await up(dba, "Kaizen DBA.pdf", bytes.dba), dbaCert: await up(corr, "Office Lease 3.pdf", bytes.dbaCert), dbaDraft: await up(dba, "Kaizen DBA draft.pdf", bytes.dbaDraft),
    ret: await up(y2024, "Tax Return 2024.pdf", bytes.ret), retCert: await up(corr, "Office Lease.pdf", bytes.retCert),
    bank: await up(banking, "Statement 2024-01.pdf", bytes.bank),
    passport: await up(contacts, "Passport.pdf", bytes.passport), itin: await up(contacts, "IRS Notice.pdf", bytes.itin), letter: await up(corr, "Capital One.pdf", bytes.letter),
    k1099: await up(y2024, "1099 Kraken.pdf", bytes.k1099),
    brokenDoc: await up(company, "Broken cert doc.pdf", bytes.brokenDoc), brokenCert: await up(corr, "Broken cert.pdf", bytes.brokenCert),
    heldFile: await up(banking, "Wise export.pdf", bytes.heldFile),
  }
  const account = await insert("accounts", { company_name: name, status: "Active", state_of_formation: "WY", drive_folder_id: top })
  const other = await insert("accounts", { company_name: otherName, status: "Active", state_of_formation: "WY", drive_folder_id: otherTop })
  const paolo = await insert("contacts", { first_name: "ZZ Plan", last_name: "Paolo Neri", full_name: "ZZ Plan Paolo Neri", email: `zz-plan-paolo-${Date.now()}@example.test` })
  const { error: linkErr } = await db.from("account_contacts").insert({ account_id: account, contact_id: paolo })
  if (linkErr) throw new Error(linkErr.message)

  const part = (b: Buffer, driveFileId: string) => ({ driveFileId, md5: md5(b), size: b.length })
  const C = { kind: "company", accountId: account, companyName: name }
  const P = { kind: "person", contactId: paolo, fullName: "ZZ Plan Paolo Neri" }
  const O = { kind: "company", accountId: other, companyName: otherName }
  const plan = {
    company: name, accountId: account,
    items: [
      { key: "articles", source: part(bytes.articles, id.articles), owner: C, folder: { kind: "company", path: [] }, name: "Articles of Organization - ZZ Plan Pilot - 2024", documentType: "articles_of_organization", year: 2024 },
      { key: "oa", source: part(bytes.oa, id.oa), appended: [part(bytes.oaCert, id.oaCert)], owner: C, folder: { kind: "company", path: [] }, name: "Operating Agreement - ZZ Plan Pilot - 2024", documentType: "operating_agreement", year: 2024 },
      { key: "dba", source: part(bytes.dba, id.dba), appended: [part(bytes.dbaCert, id.dbaCert)], owner: C, folder: { kind: "company", path: ["DBA"] }, name: "DBA Application Kaizen - ZZ Plan Pilot - 2025", documentType: null, year: 2025 },
      { key: "return", source: part(bytes.ret, id.ret), appended: [part(bytes.retCert, id.retCert)], owner: C, folder: { kind: "tax", path: ["2024"] }, name: "Tax Return Form 1065 - ZZ Plan Pilot - 2024", documentType: "tax_return", year: 2024 },
      { key: "bank", source: part(bytes.bank, id.bank), owner: C, folder: { kind: "banking", path: [] }, name: "Bank Statement - ZZ Plan Pilot - 2024-01", documentType: "bank_statement", year: 2024 },
      { key: "passport", source: part(bytes.passport, id.passport), owner: P, folder: { kind: "personal", path: [] }, name: "Passport - ZZ Plan Paolo Neri", documentType: "passport", year: null },
      { key: "itin", source: part(bytes.itin, id.itin), owner: P, folder: { kind: "personal", path: [] }, name: "ITIN Notice - ZZ Plan Paolo Neri - 2026", documentType: "itin_letter", year: 2026 },
      { key: "letter", source: part(bytes.letter, id.letter), owner: P, folder: { kind: "personal", path: ["Correspondence"] }, name: "Capital One Letter - ZZ Plan Paolo Neri - 2026", documentType: null, year: 2026 },
      { key: "k1099", source: part(bytes.k1099, id.k1099), crossCompany: true, owner: O, folder: { kind: "tax", path: ["2024"] }, name: "Form 1099 - ZZ Plan Other - 2024", documentType: null, year: 2024 },
      { key: "broken", source: part(bytes.brokenDoc, id.brokenDoc), appended: [part(bytes.brokenCert, id.brokenCert)], owner: C, folder: { kind: "company", path: [] }, name: "Broken Certificate Test - ZZ Plan Pilot", documentType: null, year: null },
    ],
    leaveInDrive: [id.dbaDraft], hold: [id.heldFile],
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(`${outDir}/plan.json`, JSON.stringify(plan, null, 1))
  const { validatePlan, planSha } = await import("@/lib/crm-store/plan-build")
  const v = validatePlan(plan)
  if (!v.plan) throw new Error(`fixture plan invalid: ${v.errors.join("; ")}`)
  const sha = planSha(v.plan)
  writeFileSync(`${outDir}/sha.txt`, sha)
  process.stdout.write(`${JSON.stringify({ account, other, paolo, folder: top, sha }, null, 1)}\n`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
