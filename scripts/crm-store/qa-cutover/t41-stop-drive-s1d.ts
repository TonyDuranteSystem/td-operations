/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script points the fixture accounts at throw-away folders */
/**
 * Stop Drive S1d (dev job 264bb882) QA against the REAL isolated TEST Shared Drive. SANDBOX only.
 * Makes throw-away folders, points the Uxio fixture (storage) and Partial Fail Test LLC (Drive) at them, then checks that
 *   - a company left on Drive (folder, no storage, Offboarding) is still written to and gets its folder back,
 *   - a Closed company's folder is read-only (the central guard) and no folder is ever created,
 *   - a company with storage / with no folder is refused, every refusal raising a staff alarm,
 *   - the backup is exempt from the archive lock.
 * Then puts everything back and trashes the folders.
 * Run: npx tsx scripts/crm-store/qa-cutover/t41-stop-drive-s1d.ts   (env from DOTENV_PATH or .env.local)
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })
process.env.GOOGLE_DRIVE_LIVE = "1"
process.env.GOOGLE_SHARED_DRIVE_ID = "0ABz0eJKly9bkUk9PVA" // the isolated TEST Shared Drive (never the production drive)

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const drive = await import("../../../lib/google-drive")
  const { ensureCompanyFolder } = await import("../../../lib/drive-folder-utils")
  const { runAsStoreBackup } = await import("../../../lib/crm-store/switched-drive-guard")
  const testDrive = process.env.GOOGLE_SHARED_DRIVE_ID as string

  const { data: tc } = await sb.from("accounts").select("id, drive_folder_id, status").eq("id", "9ad291c4-0faf-466e-8dfe-6de27f8d6306").single() // "Partial Fail Test LLC": a sandbox company with no storage
  const { data: ux } = await sb.from("accounts").select("drive_folder_id, status").eq("id", UX).single()
  const made: string[] = []
  const mk = async (parent: string, name: string) => { const f = await drive.createFolder(parent, name); made.push(f.id as string); return f.id as string }
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); return "" } catch (e) { return `${(e as Error).name}: ${(e as Error).message}` } }
  const alarmsSince = async (since: string) => {
    const { data } = await sb.from("store_events").select("reason").eq("event", "pilot_alarm").eq("reason", "drive_write_refused").gte("occurred_at", since)
    return (data ?? []).length
  }

  try {
    const stamp = Date.now()
    const folderB = await mk(testDrive, `QA Test s1d legacy-co ${stamp}`)
    const folderUx = await mk(testDrive, `QA Test s1d storage-co ${stamp}`)
    await sb.from("accounts").update({ drive_folder_id: folderUx }).eq("id", UX)

    // L1 legacy state: Offboarding + folder + no storage
    await sb.from("accounts").update({ drive_folder_id: folderB, status: "Offboarding" }).eq("id", tc.id)
    const l1 = await attempt(() => drive.uploadFile(folderB, "QA Test s1d legacy ok.txt", "fine"))
    check("L1 a company left on Drive (Offboarding, folder, no storage) is still written to", l1 === "", l1.slice(0, 200))
    const before = new Date().toISOString()
    let r1: { folderId?: string; created?: boolean } = {}
    const l2 = await attempt(async () => { r1 = await ensureCompanyFolder(tc.id, "Partial Fail Test LLC", "Wyoming") })
    check("L2 ensureCompanyFolder hands back that company's own folder, creating nothing new at the top", l2 === "" && r1.folderId === folderB && r1.created === false, l2.slice(0, 200) || JSON.stringify(r1))
    check("L3 no alarm for the allowed company", (await alarmsSince(before)) === 0)

    // L4 Closed -> archive
    await sb.from("accounts").update({ status: "Closed" }).eq("id", tc.id)
    const t4 = new Date().toISOString()
    const l4 = await attempt(() => drive.uploadFile(folderB, "QA Test s1d closed.txt", "x"))
    check("L4 a Closed company's folder is read-only (central guard)", l4.startsWith("SwitchedCompanyDriveWriteError"), l4.slice(0, 200) || "NO ERROR — written")
    const l5 = await attempt(() => drive.createFolder(folderB, "QA Test s1d closed sub"))
    check("L5 no folder can be created inside it", l5.startsWith("SwitchedCompanyDriveWriteError"), l5.slice(0, 200) || "NO ERROR")
    const l6 = await attempt(() => ensureCompanyFolder(tc.id, "Partial Fail Test LLC", "Wyoming"))
    check("L6 ensureCompanyFolder refuses a Closed company", l6.startsWith("DriveWriteRefusedError"), l6.slice(0, 200) || "NO ERROR")
    check("L7 the refusal raised a staff alarm", (await alarmsSince(t4)) >= 1)
    const l8 = await attempt(() => drive.listFolder(folderB))
    check("L8 the archive can still be READ", l8 === "", l8.slice(0, 200))
    const l9 = await attempt(() => runAsStoreBackup(() => drive.uploadFile(folderB, "QA Test s1d backup copy.txt", "backup")))
    check("L9 the storage-to-Drive backup may still write into a Closed company's folder", l9 === "", l9.slice(0, 200))

    // L10 no folder, no storage -> nothing is created
    await sb.from("accounts").update({ drive_folder_id: null, status: "Active" }).eq("id", tc.id)
    const rootBefore = ((await drive.listFolder(testDrive, 200)) as { files?: unknown[] }).files?.length ?? 0
    const l10 = await attempt(() => ensureCompanyFolder(tc.id, "Partial Fail Test LLC", "Wyoming"))
    const rootAfter = ((await drive.listFolder(testDrive, 200)) as { files?: unknown[] }).files?.length ?? 0
    check("L10 a company with no folder and no storage is refused and NO folder appears in Drive", l10.startsWith("DriveWriteRefusedError") && rootAfter === rootBefore, `${l10.slice(0, 120)} root ${rootBefore}->${rootAfter}`)

    // L11 storage company
    const l11 = await attempt(() => ensureCompanyFolder(UX, "Uxio Test LLC", "Wyoming"))
    check("L11 a company with storage is refused", /StoreOwned|Switched|DriveWriteRefused/.test(l11), l11.slice(0, 200) || "NO ERROR")
    const l12 = await attempt(() => drive.uploadFile(folderUx, "QA Test s1d storage.txt", "x"))
    check("L12 a write into a storage company's folder is still refused", l12.startsWith("SwitchedCompanyDriveWriteError"), l12.slice(0, 200) || "NO ERROR — written")
  } finally {
    await sb.from("accounts").update({ drive_folder_id: ux.drive_folder_id, status: ux.status }).eq("id", UX)
    await sb.from("accounts").update({ drive_folder_id: tc.drive_folder_id, status: tc.status }).eq("id", tc.id)
    const { runAsStoreBackup: rb } = await import("../../../lib/crm-store/switched-drive-guard")
    for (const id of made.reverse()) { try { await rb(() => drive.trashFile(id)) } catch { /* best effort */ } }
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
