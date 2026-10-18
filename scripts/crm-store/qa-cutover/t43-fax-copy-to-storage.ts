/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Stop Drive S1d QA: a faxed upload is kept in the company's storage (Tax › year, type IRS Fax). SANDBOX only.
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t43-fax-copy-to-storage.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { COMPANY_TEMPLATE, storeSafeFolderName } = await import("../../../lib/crm-store/formation-pilot")
  const { fileSentUpload } = await import("../../../lib/fax/save-sent-upload")
  const stamp = Date.now()
  const mkAcc = async (label: string) => {
    const { data, error } = await sb.from("accounts").insert({ company_name: `QA S1d Fax ${label} ${stamp} LLC`, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status: "Active" }).select("id, company_name").single()
    if (error) throw new Error(error.message)
    const { data: ownerId, error: oErr } = await (sb as unknown as { rpc: (f: string, a: unknown) => Promise<{ data: string; error: { message: string } | null }> }).rpc("store_ensure_owner", { p_kind: "company", p_ref: data.id })
    if (oErr) throw new Error(oErr.message)
    await (sb as unknown as { rpc: (f: string, a: unknown) => Promise<unknown> }).rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(data.company_name) })
    return data as { id: string; company_name: string }
  }
  const A = await mkAcc("A"), B = await mkAcc("B")
  const bytes = Buffer.from(`%PDF-1.4 fax ${stamp}`)
  const input = (accountId: string | null, name: string) => ({ accountId, serviceDeliveryId: null, fileName: name, bytes, mimeType: "application/pdf", actor: null, contentHash: "samehash" + stamp })
  try {
    const r1 = await fileSentUpload(input(A.id, `2025 Tax Return - ${A.company_name}_Signed_for_IRS.pdf`))
    check("F1 filed in the named company's storage", r1.route === "store", JSON.stringify(r1))
    const { data: row } = await sb.from("documents").select("id, account_id, portal_visible, document_type_name, drive_file_id").eq("id", (r1 as { documentRowId: string }).documentRowId).single()
    check("F2 listed against the company, hidden, typed IRS Fax", row.account_id === A.id && row.portal_visible === false && row.document_type_name === "IRS Fax", JSON.stringify(row))
    const fid = String(row.drive_file_id).replace("store:", "")
    const { data: f } = await sb.from("store_files").select("name, document_type, folder_id, period_year").eq("id", fid).single()
    const { data: fold } = await sb.from("store_folders").select("name, parent_id").eq("id", f.folder_id).single()
    check("F3 it sits in the year folder 2025 with the type irs_fax", fold.name === "2025" && f.document_type === "irs_fax" && f.period_year === 2025, JSON.stringify({ fold: fold.name, type: f.document_type, y: f.period_year }))
    const r2 = await fileSentUpload(input(B.id, `Tax Return 2025 - ${B.company_name}.pdf`))
    const { data: row2 } = await sb.from("documents").select("account_id, drive_file_id").eq("id", (r2 as { documentRowId: string }).documentRowId).single()
    check("F4 the SAME bytes faxed for company B make B its own file (not A's)", row2.account_id === B.id && row2.drive_file_id !== row.drive_file_id, `${row.drive_file_id} vs ${row2.drive_file_id}`)
    const r3 = await fileSentUpload(input(A.id, `2025 Tax Return - ${A.company_name}_Signed_for_IRS.pdf`))
    check("F5 the same bytes again for A = the same file (no second copy)", r3.route === "store" && (await sb.from("documents").select("id").eq("account_id", A.id).eq("drive_file_id", row.drive_file_id)).data.length === 1)
    const r4 = await fileSentUpload(input(A.id, "Passport copy.pdf"))
    check("F6 a personal paper is not filed in the company's storage", r4.route === "none" && (r4 as { reason: string }).reason === "personal_document", JSON.stringify(r4))
    const r5 = await fileSentUpload(input(null, `2025 Tax Return - ${A.company_name}.pdf`))
    check("F7 a company named only in the file name is found (complete list, whole name)", r5.route === "store" && (r5 as { inferred: boolean }).inferred === true, JSON.stringify(r5))
  } finally {
    for (const id of [A.id, B.id]) {
      const { data: o } = await sb.from("store_owners").select("id").eq("account_id", id)
      for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
      await sb.from("accounts").update({ status: "Cancelled" }).eq("id", id)
    }
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
