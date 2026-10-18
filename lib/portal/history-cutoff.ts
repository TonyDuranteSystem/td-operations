/**
 * Server side of the "new owner sees history from a date" rule (dev job d14e823f). See lib/documents/history-cutoff.ts.
 * Nothing here ever throws into the caller's main work: a failed read means "no cutoff" (the person sees what they saw
 * before), and a failed write of the date is reported, never swallowed silently.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isItemHiddenByCutoff, type HistoryChoice, type HistoryItem } from "@/lib/documents/history-cutoff"

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

// ---- Slice 3b: every other kind of company history (dev job d14e823f) ----

export { HISTORY_ITEM_KINDS, isHistoryItemKind, type HistoryItemKind } from "@/lib/portal/history-item-kinds"
import type { HistoryItemKind } from "@/lib/portal/history-item-kinds"

/** Every company where this person has a start date: account id -> date. Companies without a date are absent (sees everything). */
export async function getHistoryCutoffs(contactId: string | null | undefined, d: CutoffDb = supabaseAdmin): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!contactId) return out
  try {
    const { data } = await d.from("account_contacts").select("account_id, history_visible_from").eq("contact_id", contactId).not("history_visible_from", "is", null)
    for (const r of (data ?? []) as Array<{ account_id: string; history_visible_from: string | null }>) {
      if (r.history_visible_from) out.set(r.account_id, r.history_visible_from)
    }
  } catch {
    // a failed read means "no cutoff": the person sees what they saw before
  }
  return out
}

/** The ids of one kind of item staff opened to new owners for this company. Only read when there IS a cutoff. */
export async function getOpenedItemIds(accountId: string, kind: HistoryItemKind, d: CutoffDb = supabaseAdmin): Promise<Set<string>> {
  try {
    const { data } = await d.from("history_item_overrides").select("item_id").eq("account_id", accountId).eq("item_kind", kind)
    return new Set(((data ?? []) as Array<{ item_id: string }>).map(r => r.item_id))
  } catch {
    return new Set()
  }
}

/** The cutoff plus the opened items for one kind, in a single call (opened items are looked up only when there is a cutoff). */
export async function getHistoryView(accountId: string, contactId: string | null | undefined, kind: HistoryItemKind, d: CutoffDb = supabaseAdmin): Promise<{ cutoff: string | null; opened: Set<string> }> {
  const cutoff = await getHistoryCutoff(accountId, contactId, d)
  if (!cutoff) return { cutoff: null, opened: new Set() }
  return { cutoff, opened: await getOpenedItemIds(accountId, kind, d) }
}

/** Staff: open (or close again) ONE older item to people whose view starts later. Returns an error text or null. */
export async function setItemOpenToNewOwners(p: { accountId: string; kind: HistoryItemKind; itemId: string; open: boolean; by?: string | null }, d: CutoffDb = supabaseAdmin): Promise<string | null> {
  if (p.open) {
    const { error } = await d.from("history_item_overrides").upsert({ item_kind: p.kind, item_id: p.itemId, account_id: p.accountId, opened_by: p.by ?? null, opened_at: new Date().toISOString() }, { onConflict: "item_kind,item_id" })
    return error ? error.message : null
  }
  const { error } = await d.from("history_item_overrides").delete().eq("item_kind", p.kind).eq("item_id", p.itemId)
  return error ? error.message : null
}

/** One item opened by id (an invoice, its PDF...): true when this person's start date hides it. No person / no date = false. */
export async function isItemHiddenFromViewer(p: { accountId: string | null | undefined; contactId: string | null | undefined; kind: HistoryItemKind; itemId: string; item: Omit<HistoryItem, "opened"> }, d: CutoffDb = supabaseAdmin): Promise<boolean> {
  if (!p.accountId || !p.contactId) return false
  const { cutoff, opened } = await getHistoryView(p.accountId, p.contactId, p.kind, d)
  return isItemHiddenByCutoff({ ...p.item, opened: opened.has(p.itemId) }, cutoff, p.contactId)
}

/**
 * Received letters (client_correspondence) for a person: company mail from before their start date at that company is left
 * out; mail addressed to them personally (contact_id = them) and mail staff opened stay. Used by the Documents page and its API.
 */
export async function filterCorrespondenceForViewer<T extends { id: string; account_id: string | null; created_at: string; contact_id?: string | null }>(rows: T[], contactId: string | null | undefined, d: CutoffDb = supabaseAdmin): Promise<T[]> {
  const cutoffs = await getHistoryCutoffs(contactId, d)
  if (cutoffs.size === 0) return rows
  const opened = new Map<string, Set<string>>()
  for (const accId of Array.from(cutoffs.keys())) opened.set(accId, await getOpenedItemIds(accId, "correspondence", d))
  return rows.filter(c => {
    const cutoff = c.account_id ? cutoffs.get(c.account_id) : null
    if (!c.account_id || !cutoff) return true
    return !isItemHiddenByCutoff({ created_at: c.created_at, ownerContactId: c.contact_id ?? null, opened: opened.get(c.account_id)?.has(c.id) ?? false }, cutoff, contactId)
  })
}
