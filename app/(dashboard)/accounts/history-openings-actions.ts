'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { setItemOpenToNewOwners } from '@/lib/portal/history-cutoff'
import { isOpenableKind, type OlderItem, type OpenableKind } from '@/lib/portal/history-openable'

/**
 * Staff: open ONE older item (a document, invoice, expense, payment, letter, message or notice) to the people who joined the
 * company later and so see its history only from a start date (dev job d14e823f, slice 3b). Everything runs as staff only.
 */

async function requireStaff() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) throw new Error('Staff only')
  return user
}

/** The company's items saved before the LATEST start date among its people (what a later joiner cannot see), newest first. */
export async function listOlderHistoryItems(accountId: string, kind: OpenableKind): Promise<ActionResult<{ items: OlderItem[]; cutoff: string | null }>> {
  return safeAction(async () => {
    await requireStaff()
    if (!isOpenableKind(kind)) throw new Error('Unknown kind')
    const { data: ac } = await supabaseAdmin.from('account_contacts').select('history_visible_from').eq('account_id', accountId).not('history_visible_from', 'is', null)
    const dates = ((ac ?? []) as Array<{ history_visible_from: string | null }>).map(r => r.history_visible_from).filter((d): d is string => !!d).sort()
    const cutoff = dates.length ? dates[dates.length - 1] : null
    if (!cutoff) return { items: [], cutoff: null }

    const openedIds = new Set<string>()
    if (kind !== 'document') {
      const { data: ov } = await supabaseAdmin.from('history_item_overrides').select('item_id').eq('account_id', accountId).eq('item_kind', kind)
      for (const r of (ov ?? []) as Array<{ item_id: string }>) openedIds.add(r.item_id)
    }
    const db = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
    const day = (iso: string) => iso.slice(0, 10)
    let items: OlderItem[] = []

    if (kind === 'document') {
      const { data } = await db.from('documents').select('id, file_name, document_type_name, created_at, visible_to_new_owners').eq('account_id', accountId).eq('portal_visible', true).lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: d.file_name, sub: d.document_type_name ?? '', date: day(d.created_at), opened: !!d.visible_to_new_owners })) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else if (kind === 'invoice') {
      const { data } = await db.from('client_invoices').select('id, invoice_number, status, total, currency, created_at').eq('account_id', accountId).eq('source', 'client').lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: `Invoice ${d.invoice_number ?? ''}`, sub: `${d.status ?? ''} · ${d.currency ?? ''} ${d.total ?? ''}`, date: day(d.created_at), opened: openedIds.has(d.id) })) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else if (kind === 'expense') {
      const { data } = await db.from('client_expenses').select('id, vendor_name, description, status, total, currency, created_at').eq('account_id', accountId).lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: d.vendor_name || d.description || 'Expense', sub: `${d.status ?? ''} · ${d.currency ?? ''} ${d.total ?? ''}`, date: day(d.created_at), opened: openedIds.has(d.id) })) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else if (kind === 'payment') {
      const { data } = await db.from('payments').select('id, description, status, amount, created_at').eq('account_id', accountId).lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: d.description || 'Payment', sub: `${d.status ?? ''} · ${d.amount ?? ''}`, date: day(d.created_at), opened: openedIds.has(d.id) })) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else if (kind === 'correspondence') {
      const { data } = await db.from('client_correspondence').select('id, file_name, description, created_at').eq('account_id', accountId).lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: d.file_name, sub: d.description ?? '', date: day(d.created_at), opened: openedIds.has(d.id) })) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else if (kind === 'message') {
      const { data } = await db.from('portal_messages').select('id, message, sender_type, created_at').eq('account_id', accountId).is('deleted_at', null).not('message', 'ilike', '%<!-- chat-event:%').lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: String(d.message ?? '').replace(/\s+/g, ' ').slice(0, 90) || '(attachment)', sub: d.sender_type === 'admin' ? 'from the team' : 'from the client', date: day(d.created_at), opened: openedIds.has(d.id) })) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else {
      const { data } = await db.from('portal_notifications').select('id, title, type, created_at').eq('account_id', accountId).lt('created_at', cutoff).order('created_at', { ascending: false }).limit(60)
      items = (data ?? []).map((d: any) => ({ id: d.id, label: d.title, sub: d.type ?? '', date: day(d.created_at), opened: openedIds.has(d.id) })) // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    return { items, cutoff }
  })
}

/** Open (or close again) one older item for people whose view starts later. */
export async function setHistoryItemOpen(accountId: string, kind: OpenableKind, itemId: string, open: boolean): Promise<ActionResult> {
  return safeAction(async () => {
    const user = await requireStaff()
    if (!isOpenableKind(kind)) throw new Error('Unknown kind')
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw new Error('Bad item id')
    if (kind === 'document') {
      const { error } = await supabaseAdmin.from('documents').update({ visible_to_new_owners: open } as never).eq('id', itemId).eq('account_id', accountId)
      if (error) throw new Error(error.message)
    } else {
      const err = await setItemOpenToNewOwners({ accountId, kind, itemId, open, by: user.email ?? null })
      if (err) throw new Error(err)
    }
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: kind === 'document' ? 'documents' : 'history_item_overrides', record_id: itemId, account_id: accountId,
    summary: `${open ? 'Opened' : 'Closed'} one older ${kind} for people who joined the company later`,
  })
}
