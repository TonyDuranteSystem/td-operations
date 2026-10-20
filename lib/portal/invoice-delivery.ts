import { supabaseAdmin } from '@/lib/supabase-admin'

export interface DeliveryProblem {
  detail: string | null
  to: string | null
  at: string | null
}

/**
 * Invoices whose LATEST email did not reach the customer (reported by Resend afterwards). The latest attempt decides:
 * if a failed email was sent again and arrived, there is no problem to show. Newest-first rows, first one per invoice wins.
 */
export async function latestDeliveryProblems(accountId: string, invoiceIds: string[]): Promise<Map<string, DeliveryProblem>> {
  const problems = new Map<string, DeliveryProblem>()
  if (!accountId || invoiceIds.length === 0) return problems
  const { data } = await supabaseAdmin
    .from('email_tracking')
    .select('invoice_id, delivery_status, delivery_detail, recipient, delivery_updated_at, created_at')
    .eq('account_id', accountId)
    .in('invoice_id', invoiceIds)
    .order('created_at', { ascending: false })
    .limit(500)
  const seen = new Set<string>()
  for (const row of data ?? []) {
    const id = row.invoice_id as string | null
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (row.delivery_status === 'not_delivered') {
      problems.set(id, { detail: row.delivery_detail ?? null, to: row.recipient ?? null, at: row.delivery_updated_at ?? null })
    }
  }
  return problems
}
