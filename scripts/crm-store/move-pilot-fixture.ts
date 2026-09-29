/* eslint-disable no-restricted-syntax -- sandbox-only test fixture ("ZZ Drive Pilot" rows + a TEST-Drive folder), not business writes */
/**
 * Pilot fixture for "Move this company to the new storage" — SANDBOX + TEST Shared Drive only.
 * Builds a realistic company folder in the TEST Drive (5 folders, sub-folders, year folders, a member-named
 * folder, a file at the top, an unknown folder, a duplicate passport, a picture) and a sandbox company
 * "ZZ Drive Pilot LLC <date>" with two members and CRM rows for some files (visible / hidden, one kept in
 * Supabase Storage). Prints the company id: open it in the CRM → Documents → "Move this company…".
 *   npx tsx --tsconfig tsconfig.json scripts/crm-store/move-pilot-fixture.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })
import { PDFDocument, StandardFonts } from "pdf-lib"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"

async function pdf(text: string): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  d.addPage([612, 792]).drawText(text, { x: 50, y: 740, size: 12, font: f })
  return Buffer.from(await d.save())
}
// a 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

async function main() {
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

  const name = `ZZ Drive Pilot LLC ${day}`
  const top = await mk(TEST_DRIVE, name)
  const company = await mk(top, "1. Company"), contacts = await mk(top, "2. Contacts"), tax = await mk(top, "3. Tax")
  const banking = await mk(top, "4. Banking"), corr = await mk(top, "5. Correspondence"), old = await mk(top, "Old stuff")
  const y2024 = await mk(tax, "2024"), y2025 = await mk(tax, "2025"), bankLetters = await mk(company, "Bank letters")
  const lucia = await mk(contacts, "ZZ Pilot Lucia Verdi")
  const passport = await pdf("ZZ Pilot — passport of Paolo Neri (test only)")
  const f = {
    articles: await up(company, "Articles of Organization.pdf", await pdf("ZZ Pilot — Articles of Organization (test)")),
    oa: await up(company, "Operating Agreement.pdf", await pdf("ZZ Pilot — Operating Agreement (test)")),
    ein: await up(company, "EIN Letter.pdf", await pdf("ZZ Pilot — EIN letter CP575 (test)")),
    bankLetter: await up(bankLetters, "Welcome letter.pdf", await pdf("ZZ Pilot — bank welcome letter (test)")),
    passport: await up(contacts, "Passport Paolo.pdf", passport),
    passportCopy: await up(contacts, "Passport Paolo (copy).pdf", passport),
    luciaId: await up(lucia, "ID card.png", PNG, "image/png"),
    ret2024: await up(y2024, "Form 1120 2024.pdf", await pdf("ZZ Pilot — Form 1120 for 2024 (test)")),
    ret2025: await up(y2025, "Form 5472 2025 DRAFT.pdf", await pdf("ZZ Pilot — Form 5472 draft for 2025 (test)")),
    statement: await up(banking, "Statement March.pdf", await pdf("ZZ Pilot — bank statement (test)")),
    irs: await up(corr, "IRS letter.pdf", await pdf("ZZ Pilot — IRS letter (test)")),
    loose: await up(top, "Loose note.pdf", await pdf("ZZ Pilot — a file at the top of the folder (test)")),
    oldNote: await up(old, "Old note.pdf", await pdf("ZZ Pilot — something in an unknown folder (test)")),
  }
  const account = await insert("accounts", { company_name: name, status: "Active", state_of_formation: "WY", drive_folder_id: top })
  const paolo = await insert("contacts", { first_name: "ZZ Pilot", last_name: "Paolo Neri", full_name: "ZZ Pilot Paolo Neri", email: `zz-pilot-paolo-${Date.now()}@example.test` })
  const luciaC = await insert("contacts", { first_name: "ZZ Pilot", last_name: "Lucia Verdi", full_name: "ZZ Pilot Lucia Verdi", email: `zz-pilot-lucia-${Date.now()}@example.test` })
  for (const c of [paolo, luciaC]) {
    const { error } = await db.from("account_contacts").insert({ account_id: account, contact_id: c })
    if (error) throw new Error(error.message)
  }
  const legacy = async (slug: string) => (await db.from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", slug).single()).data?.metadata?.legacy_document_type_id ?? null
  const row = async (driveId: string, fileName: string, typeSlug: string | null, typeName: string | null, category: number, visible: boolean, extra: Record<string, unknown> = {}) =>
    insert("documents", { drive_file_id: driveId, file_name: fileName, account_id: account, document_type_id: typeSlug ? await legacy(typeSlug) : null, document_type_name: typeName, category, portal_visible: visible, status: "classified", ...extra })
  await row(f.articles, "Articles of Organization.pdf", "articles_of_organization", "Articles of Organization", 1, true)
  await row(f.oa, "Operating Agreement.pdf", "operating_agreement", "Operating Agreement", 1, true)
  await row(f.ein, "EIN Letter.pdf", "ein_letter_irs", "EIN Letter (IRS)", 1, false)
  await row(f.passport, "Passport Paolo.pdf", "passport", "Passport", 2, true, { contact_id: paolo })
  await row(f.ret2024, "Form 1120 2024.pdf", "form_1120", "Form 1120", 3, true, { tax_year: 2024 })
  await row(f.ret2025, "Form 5472 2025 DRAFT.pdf", "form_5472", "Form 5472", 3, false, { tax_year: 2025 })
  await row(f.statement, "Statement March.pdf", "bank_statement", "Bank Statement", 4, false)
  // one row kept in Supabase Storage (a Drive walk never finds it)
  const sp = `crm-uploads/zz-drive-pilot-${Date.now()}/Receipt.pdf`
  const { error: sErr } = await db.storage.from("onboarding-uploads").upload(sp, await pdf("ZZ Pilot — a receipt kept outside Drive (test)"), { contentType: "application/pdf" })
  if (sErr) throw new Error(sErr.message)
  await insert("documents", { drive_file_id: `storage:onboarding-uploads/${sp}`, file_name: "Receipt.pdf", account_id: account, document_type_name: "Receipt", category: 5, portal_visible: true, status: "classified", mime_type: "application/pdf" })
  process.stdout.write(`${JSON.stringify({ account, name, driveFolder: top, files: Object.keys(f).length + 1 })}\n`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
