/**
 * When a contact's name changes (a typo fixed, or two duplicate contacts merged), everything that carries that person's name follows:
 *  - the company OWNER records (`members.full_name`) that point at the contact, and
 *  - the person's storage top folder (lib/crm-store/person-root-name.ts).
 *
 * A member row's name is the legal name on the company papers and may differ on purpose from the contact's (name order, a middle name):
 * 6 of 98 differ today. So an ordinary name EDIT only renames the member rows that still carried the contact's PREVIOUS name — those were
 * following it. A MERGE is explicit (the person sees the list first), so the rows moved over from the merged-away contact take the kept
 * contact's name. Best-effort: nothing here throws or blocks the CRM step that calls it.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"

/** PURE: comparable form of a person's name (case and spacing only). */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().toLowerCase()
}

export interface MemberNameRow { id: string; account_id: string; full_name: string | null; ownership_pct?: number | null }

/** PURE: which member rows get which new name. `onlyIfNameWas` = edit (rows that carried the previous name); omitted = merge (every row). */
export function planMemberRenames(rows: MemberNameRow[], newName: string | null | undefined, onlyIfNameWas?: string | null): Array<MemberNameRow & { newName: string }> {
  const target = (newName ?? "").replace(/\s+/g, " ").trim()
  if (!target) return []
  const out: Array<MemberNameRow & { newName: string }> = []
  for (const r of rows) {
    if (nameKey(r.full_name) === nameKey(target)) continue
    if (onlyIfNameWas !== undefined && nameKey(r.full_name) !== nameKey(onlyIfNameWas)) continue
    out.push({ ...r, newName: target })
  }
  return out
}

export async function memberRowsOf(contactId: string): Promise<MemberNameRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- members columns beyond the generated subset
  const { data, error } = await (supabaseAdmin as any).from("members").select("id, account_id, full_name, ownership_pct").eq("contact_id", contactId).eq("member_type", "individual")
  if (error) throw new Error(error.message)
  return (data ?? []) as MemberNameRow[]
}

/** Renames the contact's owner records and writes one audit line. Returns how many were renamed. */
export async function renameMemberRowsForContact(contactId: string, opts: { onlyIfNameWas?: string | null; onlyIds?: string[]; actor?: string } = {}): Promise<number> {
  try {
    const { data: c } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
    const rows = (await memberRowsOf(contactId)).filter((r) => !opts.onlyIds || opts.onlyIds.includes(r.id))
    const plan = planMemberRenames(rows, c?.full_name, opts.onlyIfNameWas)
    let done = 0
    for (const p of plan) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-restricted-syntax -- members.full_name follows the contact (audited below)
      const { error } = await (supabaseAdmin as any).from("members").update({ full_name: p.newName, updated_at: new Date().toISOString() }).eq("id", p.id)
      if (!error) done++
    }
    if (done > 0) {
      logAction({
        actor: opts.actor ?? "system", action_type: "update", table_name: "members", record_id: contactId,
        summary: `Owner record name${done > 1 ? "s" : ""} follow the contact's name (${done})`,
        details: { renamed: plan.map((p) => ({ member: p.id, account: p.account_id, from: p.full_name, to: p.newName })) },
      })
    }
    return done
  } catch (e) {
    console.error("[contact-name-follow] could not rename the owner records:", e instanceof Error ? e.message : String(e))
    return 0
  }
}

/** One call for a name EDIT: `oldName` is the contact's name BEFORE the change. */
export async function afterContactNameEdit(contactId: string, oldName: string | null | undefined, actor?: string): Promise<void> {
  try {
    await renameMemberRowsForContact(contactId, { onlyIfNameWas: oldName ?? null, actor })
    await (await import("@/lib/crm-store/person-root-name")).syncPersonRootName(contactId)
  } catch { /* best-effort */ }
}

/** The contact's current name, read just before an edit. null when unreadable (the edit goes on). */
export async function nameBeforeEdit(contactId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
    return (data?.full_name as string | null | undefined) ?? null
  } catch { return null }
}
