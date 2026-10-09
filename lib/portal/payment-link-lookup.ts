/**
 * Which payment link goes on an invoice: the company's default, or, if none is marked (an old data slip, or a delete
 * that raced), its OLDEST link. Only a plain https link is ever returned (see payment-link-rules.ts).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { validatePaymentLinkUrl } from '@/lib/portal/payment-link-rules'

export async function getInvoicePaymentLinkUrl(accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null
  const { data } = await supabaseAdmin
    .from('payment_links')
    .select('url, is_default, created_at')
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at')
    .limit(1)
  const url = data?.[0]?.url
  if (!url) return null
  const check = validatePaymentLinkUrl(url)
  return 'url' in check ? check.url : null
}
