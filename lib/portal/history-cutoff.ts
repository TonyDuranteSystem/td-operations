/**
 * Server side of the "new owner sees history from a date" rule (dev job d14e823f). See lib/documents/history-cutoff.ts.
 * Nothing here ever throws into the caller's main work: a failed read means "no cutoff" (the person sees what they saw
 * before), and a failed write of the date is reported, never swallowed silently.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HistoryChoice } from "@/lib/documents/history-cutoff"

export type CutoffDb = Pick<typeof supabaseAdmin, "from">

/** The date from which this person may see this company's history, or null (sees everything / not a person). */
export async function getHistoryCutoff(accountId: string, contactId: string | null | undefined, d: CutoffDb = supabaseAdmin): Promise<string | null> {
  if (!contactId) return null
  try {
    const { data } = await d.from("account_contacts").select("history_visible_from").eq("account_id", accountId).eq("contact_id", contactId).maybeSingle()
    return ((data as { history_visible_from?: string | null } | null)?.history_visible_from) ?? null
  } catch {
    return null
  }
}

/**
 * The value to store for a person being linked NOW. `undefined` = leave the column alone (already linked: never change an
 * existing person's view by re-adding them). null = sees everything. A timestamp = sees from then.
 * Only a company that already has client-visible documents gets a cutoff — a brand-new company has no history to hide,
 * and documents saved a moment before the link (formation papers) must never be cut off.
 */
export async function historyFromForNewLink(p: { accountId: string; contactId: string; choice: HistoryChoice; now?: Date }, d: CutoffDb = supabaseAdmin): Promise<string | null | undefined> {
  try {
    const { data: existing } = await d.from("account_contacts").select("account_id").eq("account_id", p.accountId).eq("contact_id", p.contactId).maybeSingle()
    if (existing) return undefined
    if (p.choice === "all") return null
    const { count } = await d.from("documents").select("id", { count: "exact", head: true }).eq("account_id", p.accountId).eq("portal_visible", true)
    if ((count ?? 0) === 0) return null
    return (p.now ?? new Date()).toISOString()
  } catch {
    return null
  }
}

/**
 * A person who was just created and linked in one step (the CRM "add contact" box) starts seeing history from now, when the
 * company already has client-visible documents. Only ever called for a brand-new contact, so there is no earlier view to protect.
 */
export async function startHistoryFromNow(p: { accountId: string; contactId: string; now?: Date }, d: CutoffDb = supabaseAdmin): Promise<boolean> {
  try {
    const { count } = await d.from("documents").select("id", { count: "exact", head: true }).eq("account_id", p.accountId).eq("portal_visible", true)
    if ((count ?? 0) === 0) return false
    const { error } = await d.from("account_contacts").update({ history_visible_from: (p.now ?? new Date()).toISOString() }).eq("account_id", p.accountId).eq("contact_id", p.contactId)
    return !error
  } catch {
    return false
  }
}
