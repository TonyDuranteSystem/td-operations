/* eslint-disable no-console -- a proof script prints its results */
/**
 * Sandbox proof for the form-filing route (dev job ad09ea91, Phase 2): the REAL sandbox database + storage.
 *  - the Uxio Test LLC fixture's Drive folder resolves to a switched company → a tax-return summary lands in 3. Tax › <year>
 *  - a company still on Drive → resolves to null (the Drive path runs)
 * Run: npx tsx scripts/crm-store/save-form-proof.ts   (refuses to run against production)
 */
import { config } from "dotenv"
config({ path: ".env.local" })

const STORE_COMPANY = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // Uxio Test LLC (QA fixture)

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../lib/supabase-admin")
  const { switchedTargetForFolder, saveFormToStore } = await import("../../lib/crm-store/save-form")
  const g = await import("../../lib/crm-store/switched-drive-guard")

  const { data: uxio } = await supabaseAdmin.from("accounts").select("drive_folder_id").eq("id", STORE_COMPANY).single()
  const target = await switchedTargetForFolder(uxio!.drive_folder_id as string)
  console.log("Uxio's Drive folder resolves to:", target)

  const r = await saveFormToStore({
    target: target!, subfolder: "3. Tax", year: 2025,
    summary: { name: "QA Test Tax_Data summary.pdf", bytes: Buffer.from(`%PDF-1.4 QA Test form summary ${Date.now()}`), documentType: null, callerKey: `qa-form-proof:${Date.now()}` },
    uploadPaths: [], bucketOf: () => "onboarding-uploads", submissionKey: `qa-form-proof:${Date.now()}`,
  })
  console.log("saved:", r)

  if (r.summaryFileId) {
    const { data: f } = await (supabaseAdmin as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { single: () => Promise<{ data: { folder_id: string } | null }> } } } }).from("store_files").select("folder_id").eq("id", r.summaryFileId).single()
    const { data: fo } = await (supabaseAdmin as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { single: () => Promise<{ data: unknown }> } } } }).from("store_folders").select("name, kind, parent_id").eq("id", f!.folder_id).single()
    console.log("the file sits in folder:", fo)
  }

  const { data: accts } = await supabaseAdmin.from("accounts").select("id, company_name, drive_folder_id").not("drive_folder_id", "is", null).limit(60)
  for (const a of (accts ?? []) as Array<{ id: string; company_name: string; drive_folder_id: string }>) {
    if ((await g.companyDocState(a.id)) === "drive") {
      console.log(`company still on Drive (${a.company_name}) resolves to:`, await switchedTargetForFolder(a.drive_folder_id))
      break
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
