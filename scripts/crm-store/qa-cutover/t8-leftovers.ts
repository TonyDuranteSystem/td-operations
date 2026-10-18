/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * Phase 3 QA t8: the leftovers found by the Drive-writer sweep — MCP ITIN document set, closure documents, the AI assistant's
 * file tool, the ITIN folder rule and the person-keyed form seam. Real handlers, real sandbox DB. SANDBOX only.
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const TC_CONTACT = "963ee27f-7531-4fe4-9a4d-60a4fc6c36cc"

type Handler = (p: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
function capture(register: (s: unknown) => void): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  register({ tool: (...args: unknown[]) => { handlers[args[0] as string] = args[args.length - 1] as Handler } })
  return handlers
}

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const newRows = async (filter: (q: any) => any) => ((await filter(sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name, file_name, contact_id, account_id").gt("created_at", t0))).data ?? []) as Array<{ id: string; drive_file_id: string; portal_visible: boolean; document_type_name: string; file_name: string; contact_id: string | null; account_id: string | null }> // eslint-disable-line @typescript-eslint/no-explicit-any

  // ── ITIN folder rule: a storage person has no Drive folder; a Drive person is unchanged ───────────────────
  const { resolveItinContactFolder } = await import("../../../lib/forms/itin-contact-folder")
  const uxFolder = await resolveItinContactFolder({ accountId: UX, contactId: UX_CONTACT, clientName: "QA Test Cutover" })
  check("I1 a person of a switched company gets a storage marker, not a Drive folder", uxFolder === `person-storage:${UX_CONTACT}`, uxFolder)
  const { data: tcLink } = await sb.from("account_contacts").select("account_id").eq("contact_id", TC_CONTACT).limit(1).maybeSingle()
  const tcFolder = await resolveItinContactFolder({ accountId: tcLink?.account_id ?? null, contactId: TC_CONTACT, clientName: "QA Test Drive Person" })
  check("I2 a Drive person still gets a Drive folder", !tcFolder.startsWith("person-storage:"), tcFolder)

  // ── the person-keyed form seam: ITIN summary lands in the PERSON's storage ──────────────────────────────────
  const { saveFormToDrive } = await import("../../../lib/form-to-drive")
  const token = `qa-${randomBytes(5).toString("hex")}`
  const sample = { first_name: "QA", last_name: "Test", email: "qa-test@example.test" }
  const r = await saveFormToDrive("itin", sample, [], uxFolder, { token, submittedAt: new Date().toISOString(), companyName: "QA Test Cutover" }, { person: { contactId: UX_CONTACT, viaAccountId: UX, name: "QA Test Cutover" } })
  check("I3 the ITIN summary is saved in the person's storage (no Drive, no errors)", !!r.summaryFileId?.startsWith("store:") && r.errors.length === 0, JSON.stringify(r))
  if (r.summaryFileId) {
    const { data: sf } = await sb.from("store_files").select("owner_id").eq("id", r.summaryFileId.replace("store:", "")).maybeSingle()
    const { data: ow } = await sb.from("store_owners").select("kind, contact_id").eq("id", sf?.owner_id).maybeSingle()
    check("I4 …in a PERSON storage of that contact", ow?.kind === "person" && ow?.contact_id === UX_CONTACT, JSON.stringify(ow))
  }
  const noOverride = await saveFormToDrive("itin", sample, [], uxFolder, { token: `${token}-b`, submittedAt: new Date().toISOString(), companyName: "QA Test" })
  check("I5 without the person override the marker is refused, nothing written", noOverride.summaryFileId === null && noOverride.errors.length > 0, JSON.stringify(noOverride))

  // ── MCP: ITIN document set for a storage person ────────────────────────────────────────────────────────────
  const { registerITINFormTools } = await import("../../../lib/mcp/tools/itin-form")
  const itin = capture((s) => registerITINFormTools(s as never))
  const itinToken = `qa-itin-${randomBytes(5).toString("hex")}`
  const submitted = { first_name: "QA", last_name: "Cutover", dob: "1990-01-01", gender: "Male", citizenship: "Italy", country_of_birth: "Italy", city_of_birth: "Rome", foreign_street: "Via QA 1", foreign_city: "Rome", foreign_zip: "00100", foreign_country: "Italy", passport_number: "QA123", passport_country: "Italy", passport_expiry: "2030-01-01", email: "qa-test@example.test" }
  const ins = await sb.from("itin_submissions").insert({ token: itinToken, account_id: UX, contact_id: UX_CONTACT, status: "completed", submitted_data: submitted, language: "en", access_code: "123456" }).select("id").single()
  if (ins.error) console.log("      fixture itin insert failed:", ins.error.message)
  else {
    const res = await itin["itin_prepare_documents"]({ token: itinToken, send_email: false })
    const text = res.content.map((c) => c.text).join("\n")
    console.log(`      (info) ${text.split("\n").filter((l) => /W-7|1040|OI|⚠|❌/.test(l)).join(" | ").slice(0, 300)}`)
    const rows = await newRows((q) => q.eq("contact_id", UX_CONTACT))
    const set = rows.filter((x) => ["W-7", "1040-NR", "Schedule OI"].includes(x.document_type_name))
    check("M1 the three ITIN PDFs are listed as storage pointers", set.length === 3 && set.every((x) => x.drive_file_id.startsWith("store:")), JSON.stringify(set))
    await itin["itin_prepare_documents"]({ token: itinToken, send_email: false })
    const again = (await newRows((q) => q.eq("contact_id", UX_CONTACT))).filter((x) => ["W-7", "1040-NR", "Schedule OI"].includes(x.document_type_name))
    check("M2 running it again adds no second copy", again.length === 3, `rows ${again.length}`)
  }

  // ── MCP: closure documents for a storage company (EIN letter; state with no template needs no Drive read) ─────
  const { registerClosureTools } = await import("../../../lib/mcp/tools/closure")
  const closure = capture((s) => registerClosureTools(s as never))
  const { data: before } = await sb.from("accounts").select("ein_number, state_of_formation").eq("id", UX).single()
  await sb.from("accounts").update({ ein_number: before.ein_number || "00-0000000", state_of_formation: "Florida" }).eq("id", UX)
  try {
    const res = await closure["closure_prepare_documents"]({ account_id: UX, send_email: false })
    const text = res.content.map((c) => c.text).join("\n")
    console.log(`      (info) ${text.split("\n").filter((l) => /📁|⚠|EIN/.test(l)).join(" | ").slice(0, 300)}`)
    // (not filtered by "new": on a repeat run the same letter is a new VERSION of the existing row)
    const rows = ((await sb.from("documents").select("id, drive_file_id, portal_visible, file_name").eq("account_id", UX).eq("document_type_name", "Closure document")).data ?? []) as Array<{ drive_file_id: string; portal_visible: boolean; file_name: string }>
    const letter = rows.filter((x) => x.file_name.startsWith("EIN_Closure_Letter"))
    check("C1 the closure letter is saved in the company's storage, internal, ONE row", letter.length === 1 && letter[0].drive_file_id.startsWith("store:") && letter[0].portal_visible === false, JSON.stringify(rows))
  } finally {
    await sb.from("accounts").update({ ein_number: before.ein_number, state_of_formation: before.state_of_formation }).eq("id", UX)
  }

  // ── MCP: the P&L workbook (Uxio has real-shaped sandbox transactions) ─────────────────────────────────────────
  const { registerBankStatementTools } = await import("../../../lib/mcp/tools/bank-statements")
  const bank = capture((s) => registerBankStatementTools(s as never))
  const { data: yrRow } = await sb.from("bank_transactions").select("tax_year").eq("account_id", UX).limit(1).maybeSingle()
  const pnlYear = Number(yrRow?.tax_year ?? 2025)
  const pnl = await bank["bank_statement_pnl"]({ account_id: UX, tax_year: pnlYear, upload_to_drive: true, notify_client: false })
  const pnlText = pnl.content.map((c) => c.text).join("\n")
  console.log(`      (info) ${pnlText.split("\n").slice(0, 3).join(" | ").slice(0, 240)}`)
  const allPnl = async () => ((await sb.from("documents").select("id, drive_file_id, portal_visible").eq("account_id", UX).eq("document_type_name", "Profit & Loss Statement").like("file_name", `%PnL ${pnlYear}%`)).data ?? []) as Array<{ id: string; drive_file_id: string; portal_visible: boolean }>
  const pnlRows = await allPnl()
  check("P1 the P&L workbook is saved in the company's storage and shown to the client", pnlRows.length === 1 && pnlRows[0].drive_file_id.startsWith("store:") && pnlRows[0].portal_visible === true, `${pnlText.slice(0, 160)} rows=${JSON.stringify(pnlRows)}`)
  await bank["bank_statement_pnl"]({ account_id: UX, tax_year: pnlYear, upload_to_drive: true, notify_client: false })
  const pnlAgain = await allPnl()
  check("P2 regenerating it is a new version of the same file (one row, same pointer)", pnlAgain.length === 1 && pnlAgain[0].drive_file_id === pnlRows[0]?.drive_file_id, JSON.stringify(pnlAgain))

  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
