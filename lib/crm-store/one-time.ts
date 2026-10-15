/**
 * One-time customers — give every ACTIVE One-Time company that has no storage yet an (empty) storage of its own
 * (Antonio 2026-10-15, dev job ad09ea91). Owners only; each company is checked first: it must have no Drive folder and no
 * CRM documents (anything else needs the normal copy + switch, never this), and no storage yet. Idempotent.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ONE_TIME_ACCOUNT_TYPE } from "./structure"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface OneTimeCandidate { accountId: string; companyName: string; ok: boolean; why: string | null }

/** Pure: may this company get an empty storage? */
export function oneTimeBlocker(c: { accountType: string | null; status: string | null; hasDriveFolder: boolean; documentCount: number; hasStorage: boolean }): string | null {
  if (c.accountType !== ONE_TIME_ACCOUNT_TYPE) return "not a One-Time company in the CRM"
  if (c.status !== "Active") return "not Active"
  if (c.hasStorage) return "already has a storage"
  if (c.hasDriveFolder) return "has a Drive folder — it needs the normal copy and switch"
  if (c.documentCount > 0) return "has documents in the CRM — it needs the normal copy and switch"
  return null
}

export async function planOneTimeStorages(): Promise<OneTimeCandidate[]> {
  const { data: accts, error } = await db().from("accounts").select("id, company_name, status, account_type, drive_folder_id").eq("account_type", ONE_TIME_ACCOUNT_TYPE).eq("status", "Active").order("company_name")
  if (error) throw new Error(`Could not read the One-Time companies (${error.message}).`)
  const out: OneTimeCandidate[] = []
  for (const a of (accts ?? []) as Array<{ id: string; company_name: string; status: string | null; account_type: string | null; drive_folder_id: string | null }>) {
    const [{ data: owner }, { count }] = await Promise.all([
      db().from("store_owners").select("id").eq("account_id", a.id).eq("kind", "company").maybeSingle(),
      db().from("documents").select("id", { count: "exact", head: true }).eq("account_id", a.id),
    ])
    const why = oneTimeBlocker({ accountType: a.account_type, status: a.status, hasDriveFolder: !!a.drive_folder_id, documentCount: count ?? 0, hasStorage: !!owner })
    if (why === "already has a storage") continue
    out.push({ accountId: a.id, companyName: a.company_name, ok: why === null, why })
  }
  return out
}

export async function createOneTimeStorages(): Promise<{ created: string[]; skipped: Array<{ company: string; why: string }>; failed: Array<{ company: string; error: string }> }> {
  const { COMPANY_TEMPLATE, storeSafeFolderName } = await import("./formation-pilot")
  const plan = await planOneTimeStorages()
  const created: string[] = [], skipped: Array<{ company: string; why: string }> = [], failed: Array<{ company: string; error: string }> = []
  for (const c of plan) {
    if (!c.ok) { skipped.push({ company: c.companyName, why: c.why ?? "" }); continue }
    try {
      const { data: ownerId, error } = await db().rpc("store_ensure_owner", { p_kind: "company", p_ref: c.accountId })
      if (error || !ownerId) throw new Error(error?.message ?? "no id")
      const { error: tErr } = await db().rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(c.companyName) })
      if (tErr) throw new Error(tErr.message)
      created.push(c.companyName)
    } catch (e) {
      failed.push({ company: c.companyName, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { created, skipped, failed }
}
