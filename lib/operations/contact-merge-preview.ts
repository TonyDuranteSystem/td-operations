/**
 * The plain-English preview shown before two contacts are merged (the CRM "Delete / Merge" dialog, Merge tab).
 * Reads only; the merge itself is the database function `merge_contacts` run by the delete-contact route.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { DryRunResult } from "@/lib/operations/destructive"
import { memberRowsOf, planMemberRenames, nameKey } from "@/lib/operations/contact-name-follow"
import { storeMergeBlocker } from "@/lib/crm-store/merge-guard"

export interface MergePreviewInput {
  loserId: string
  winnerId: string | null
  report: { total_blocking: number; breakdown: Record<string, number> }
  portalLoginCount: number
}

/** PURE: companies where BOTH contacts are individual owners — merging would leave the same person twice in one company. */
export function sharedMemberAccounts(loser: Array<{ account_id: string }>, winner: Array<{ account_id: string }>): string[] {
  const w = new Set(winner.map((m) => m.account_id))
  return Array.from(new Set(loser.map((m) => m.account_id).filter((id) => w.has(id))))
}

/** PURE: "email_index.contact_id" -> "email index" */
export function plainReference(key: string): string {
  return key.replace(/\.[a-z_]*contact_id$/, "").replace(/_/g, " ")
}

export async function buildMergePreview(i: MergePreviewInput): Promise<DryRunResult> {
  const fail = (blocker: string): DryRunResult => ({ affected: {}, items: [], blocker })
  if (!i.winnerId) return fail("Choose the contact to keep.")
  if (i.winnerId === i.loserId) return fail("A contact cannot be merged into itself.")
  const { data: pair } = await supabaseAdmin.from("contacts").select("id, full_name, email, merged_into, portal_tier").in("id", [i.loserId, i.winnerId])
  const loser = (pair ?? []).find((c) => c.id === i.loserId)
  const winner = (pair ?? []).find((c) => c.id === i.winnerId)
  if (!loser || !winner) return fail("One of the two contacts was not found.")
  if (winner.merged_into) return fail(`"${winner.full_name}" was already merged into another contact — choose the one that is kept.`)
  if (loser.merged_into) return fail(`"${loser.full_name}" was already merged into another contact.`)

  const storeBlock = await storeMergeBlocker(i.loserId, i.winnerId)
  if (storeBlock) return fail(storeBlock)

  const loserMembers = await memberRowsOf(i.loserId)
  const winnerMembers = await memberRowsOf(i.winnerId)
  const shared = sharedMemberAccounts(loserMembers, winnerMembers)
  if (shared.length > 0) {
    const { data: accts } = await supabaseAdmin.from("accounts").select("company_name").in("id", shared)
    return fail(`Both contacts are listed as owners of ${(accts ?? []).map((a) => a.company_name).join(", ")}. Remove the duplicate owner entry there first, then merge.`)
  }

  const items: DryRunResult["items"] = []
  const label = (n: string | null) => n || "(no name)"
  items.push({ label: `Kept: ${label(winner.full_name)}${winner.email ? ` (${winner.email})` : ""}` })
  items.push({ label: `Merged away: ${label(loser.full_name)}${loser.email ? ` (${loser.email})` : ""} — stays only as a marker pointing at the kept contact` })
  // the owner records and the storage get their own, more precise lines below
  for (const [key, n] of Object.entries(i.report.breakdown)) {
    if (/^(members|store_owners)(\.|$)/.test(key)) continue
    items.push({ label: `${n} linked record${n === 1 ? "" : "s"} (${plainReference(key)}) move to the kept contact` })
  }

  if (loserMembers.length > 0) {
    const { data: accts } = await supabaseAdmin.from("accounts").select("id, company_name").in("id", loserMembers.map((m) => m.account_id))
    const nameOf = new Map((accts ?? []).map((a) => [a.id as string, a.company_name as string]))
    for (const m of loserMembers) {
      const renamed = planMemberRenames([m], winner.full_name).length > 0
      items.push({ label: `Owner of ${nameOf.get(m.account_id) ?? "a company"}${m.ownership_pct != null ? ` (${m.ownership_pct}%)` : ""} moves to the kept contact${renamed ? `; its name "${m.full_name}" becomes "${winner.full_name}"` : ""}` })
    }
  }
  const { data: owners } = await supabaseAdmin.from("store_owners").select("id").eq("contact_id", i.loserId).eq("kind", "person").limit(1)
  if ((owners ?? []).length > 0) items.push({ label: `The merged-away contact's storage (files and folders) moves to the kept contact; its top folder is renamed "${winner.full_name}"` })
  if (i.portalLoginCount > 0) items.push({ label: `portal login${i.portalLoginCount > 1 ? "s" : ""} of the merged-away contact: ${i.portalLoginCount} (will be removed)` })

  const warnings: string[] = []
  if (nameKey(loser.full_name) !== nameKey(winner.full_name)) warnings.push(`The two names differ: kept "${label(winner.full_name)}", merged away "${label(loser.full_name)}". Check you are keeping the right one.`)
  if (i.portalLoginCount > 0) {
    const { findAuthUsersByContactId } = await import("@/lib/auth-admin-helpers")
    const winnerLogins = await findAuthUsersByContactId(i.winnerId).catch(() => [])
    if (winnerLogins.length === 0) warnings.push("The kept contact has no portal login but the merged-away one does. The login will be removed — the kept contact will need a portal login created.")
  }
  warnings.push("A merge cannot be undone from the screen.")
  return {
    affected: { moved: i.report.total_blocking, owner_records: loserMembers.length },
    items,
    warnings,
    record_label: `${label(loser.full_name)} → ${label(winner.full_name)}`,
  }
}
