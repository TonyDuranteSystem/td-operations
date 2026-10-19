import { createClient } from '@/lib/supabase/server'
import { filterByHistoryCutoff, isHiddenByHistoryCutoff, isSettledPaymentStatus } from '@/lib/documents/history-cutoff'
import { getHistoryCutoff, getHistoryView } from '@/lib/portal/history-cutoff'
import { NextRequest, NextResponse } from 'next/server'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { EnhancedSearchResult } from '@/lib/types'
import { isPersonalDocumentHiddenFrom } from '@/lib/documents/visibility-guard'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/portal/search?q=term&account_id=uuid
 * Client-scoped search within the selected account's data.
 * Searches: documents, services, invoices (payments), deadlines.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ results: [] })

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''
  const accountId = searchParams.get('account_id') ?? ''

  if (q.length < 2) return NextResponse.json({ results: [] })

  // Validate client has access to this account
  const accountIds = await getClientAccountIds(contactId)
  if (!accountIds.includes(accountId)) {
    return NextResponse.json({ results: [] })
  }

  const pattern = `%${q}%`
  const limit = 6
  // A person who joined the company later cannot find, by search, what the pages hide from them (dev job d14e823f).
  const docCutoff = await getHistoryCutoff(accountId, contactId)
  const payHistory = await getHistoryView(accountId, contactId, 'payment')

  async function searchDocuments(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, document_type_name, category, contact_id, drive_file_id, portal_visible, service_delivery_id, flow_stage, created_at, visible_to_new_owners')
      .eq('account_id', accountId)
      .or(`file_name.ilike.${pattern},document_type_name.ilike.${pattern}`)
      .or(`category.neq.2,category.is.null,contact_id.eq.${contactId}`)
      .order('created_at', { ascending: false })
      .limit(limit * 4)

    const catLabels: Record<number, string> = { 1: 'Company', 2: 'Contacts', 3: 'Tax', 4: 'Banking', 5: 'Correspondence' }
    // Never surface another member's personal document (passport/ID/ITIN…), not even by name; and a document in the NEW storage
    // only when the client could open it (hidden / internal files are not named). Drive rows are untouched.
    const { dropStoreRowsClientCannotOpen } = await import('@/lib/portal/client-store-docs')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visibleToThisClient = await dropStoreRowsClientCannotOpen(((data ?? []) as any[]).filter((d: any) => !isPersonalDocumentHiddenFrom(d, contactId) && !isHiddenByHistoryCutoff(d, docCutoff, contactId)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return visibleToThisClient.slice(0, limit).map((d: any) => ({
      id: d.id,
      title: d.file_name,
      subtitle: d.document_type_name ?? 'Document',
      type: 'document' as const,
      href: '/portal/documents',
      preview: {
        document_type: d.document_type_name,
        category: catLabels[d.category] ?? null,
      },
    }))
  }

  async function searchServices(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_name, service_type, stage, status')
      .eq('account_id', accountId)
      .or(`service_name.ilike.${pattern},service_type.ilike.${pattern}`)
      .limit(limit)
    return (data ?? []).map((s: any) => ({
      id: s.id,
      title: s.service_name ?? s.service_type,
      subtitle: [s.status, s.stage].filter(Boolean).join(' \u00b7 '),
      type: 'service' as const,
      href: '/portal/services',
      preview: {
        service_type: s.service_type,
        stage: s.stage,
        status: s.status,
      },
    }))
  }

  async function searchInvoices(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabaseAdmin
      .from('payments')
      .select('id, description, amount, currency, status, due_date, created_at')
      .eq('account_id', accountId)
      .ilike('description', pattern)
      .order('created_at', { ascending: false })
      .limit(limit)
    const shown = filterByHistoryCutoff((data ?? []) as any[], payHistory.cutoff, contactId, (p: any) => ({ created_at: p.created_at, opened: payHistory.opened.has(p.id) || !isSettledPaymentStatus(p.status) }))
    return shown.map((p: any) => ({
      id: p.id,
      title: p.description ?? 'Payment',
      subtitle: `${p.currency ?? 'USD'} ${p.amount ?? 0} \u00b7 ${p.status ?? ''}`,
      type: 'invoice' as const,
      href: '/portal/billing',
      preview: {
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        due_date: p.due_date,
      },
    }))
  }

  async function searchDeadlines(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabaseAdmin
      .from('deadlines')
      .select('id, deadline_type, due_date, status')
      .eq('account_id', accountId)
      .ilike('deadline_type', pattern)
      .limit(limit)
    return (data ?? []).map((dl: any) => ({
      id: dl.id,
      title: dl.deadline_type,
      subtitle: [dl.status, dl.due_date].filter(Boolean).join(' \u00b7 '),
      type: 'deadline' as const,
      href: '/portal/deadlines',
      preview: {
        status: dl.status,
        due_date: dl.due_date,
      },
    }))
  }

  const settled = await Promise.allSettled([
    searchDocuments(),
    searchServices(),
    searchInvoices(),
    searchDeadlines(),
  ])

  const results = settled
    .filter((r): r is PromiseFulfilledResult<EnhancedSearchResult[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  return NextResponse.json({ results })
}
