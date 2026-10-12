/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script points the fixture accounts at throw-away folders */
/**
 * Phase 3 QA t5 (Pass B): the Drive-write guard against the REAL isolated TEST Shared Drive. SANDBOX only.
 * Makes throw-away folders in the test drive, points the Uxio fixture (switched) and Test Company LLC (Drive) at them,
 * checks what the guard allows and refuses, then puts everything back and trashes the folders.
 * Run: npx tsx scripts/crm-store/qa-cutover/t5-guard-live-drive.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })
process.env.GOOGLE_DRIVE_LIVE = "1"
process.env.GOOGLE_SHARED_DRIVE_ID = "0ABz0eJKly9bkUk9PVA" // the isolated TEST Shared Drive (never the production drive)

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const drive = await import("../../../lib/google-drive")
  const { SwitchedCompanyDriveWriteError } = await import("../../../lib/crm-store/switched-drive-guard")
  const testDrive = process.env.GOOGLE_SHARED_DRIVE_ID as string

  const { data: tc } = await sb.from("accounts").select("id, drive_folder_id").eq("company_name", "Test Company LLC").limit(1).maybeSingle()
  const { data: ux } = await sb.from("accounts").select("drive_folder_id").eq("id", UX).single()
  const made: string[] = []
  const mk = async (parent: string, name: string) => { const f = await drive.createFolder(parent, name); made.push(f.id as string); return f.id as string }

  try {
    const stamp = Date.now()
    const folderA = await mk(testDrive, `QA Test cutover switched ${stamp}`)
    const childA = await mk(folderA, "1. Company") // a sub-folder BEFORE the lock, to prove the depth walk
    const folderB = await mk(testDrive, `QA Test cutover drive-co ${stamp}`)
    await sb.from("accounts").update({ drive_folder_id: folderA }).eq("id", UX)
    await sb.from("accounts").update({ drive_folder_id: folderB }).eq("id", tc.id)

    const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); return "" } catch (e) { return `${(e as Error).name}: ${(e as Error).message}` } }

    const g1 = await attempt(() => drive.uploadFile(folderA, "QA Test guard.txt", "x"))
    check("G1 upload into the switched company's root folder is refused", g1.startsWith("SwitchedCompanyDriveWriteError"), g1.slice(0, 200) || "NO ERROR — written")
    const g2 = await attempt(() => drive.createFolder(folderA, "QA Test guard sub"))
    check("G2 creating a folder under it is refused", g2.startsWith("SwitchedCompanyDriveWriteError"), g2.slice(0, 200) || "NO ERROR")
    const g3 = await attempt(() => drive.uploadFile(childA, "QA Test guard deep.txt", "x"))
    check("G3 upload into a sub-folder of it is refused (depth walk)", g3.startsWith("SwitchedCompanyDriveWriteError"), g3.slice(0, 200) || "NO ERROR — written")
    const g4 = await attempt(() => drive.uploadFile(folderB, "QA Test guard ok.txt", "fine"))
    check("G4 upload into a company still on Drive is allowed", g4 === "", g4.slice(0, 200))
    const g5 = await attempt(() => drive.createFolder(folderB, "QA Test guard sub ok"))
    check("G5 creating a folder for a Drive company is allowed", g5 === "", g5.slice(0, 200))

    // the storage's own backup is exempt from the lock (it writes copies INTO Drive)
    const { runAsStoreBackup } = await import("../../../lib/crm-store/switched-drive-guard")
    const g6 = await attempt(() => runAsStoreBackup(() => drive.uploadFile(folderA, "QA Test backup copy.txt", "backup")))
    check("G6 the storage-to-Drive backup may still write into a switched company's folder", g6 === "", g6.slice(0, 200))

    // reading is never blocked
    const g7 = await attempt(() => drive.listFolder(folderA))
    check("G7 staff can still LIST the switched company's Drive folder (read-only visibility)", g7 === "", g7.slice(0, 200))
    // a write while the company is "moving": locked as well
    const { data: run } = await sb.from("store_import_runs").insert({ account_id: tc.id, mode: "move", status: "moving" }).select("id").single()
    const g8 = await attempt(() => drive.uploadFile(folderB, "QA Test guard moving.txt", "x"))
    check("G8 a company in the middle of moving is locked too", g8.startsWith("SwitchedCompanyDriveWriteError"), g8.slice(0, 200) || "NO ERROR — written")
    if (run) await sb.from("store_import_runs").delete().eq("id", run.id)
    void SwitchedCompanyDriveWriteError
  } finally {
    await sb.from("accounts").update({ drive_folder_id: ux.drive_folder_id }).eq("id", UX)
    await sb.from("accounts").update({ drive_folder_id: tc.drive_folder_id }).eq("id", tc.id)
    for (const id of made.reverse()) { try { await drive.trashFile(id) } catch { /* best effort */ } }
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
