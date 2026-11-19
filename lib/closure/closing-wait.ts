/**
 * Which companies are waiting for their final tax return before they close (dev job 0a60f416, part C).
 *
 * A company waits when its closure job left the marker note (lib/closure/pending-return.ts) and the company is not Closed yet. These companies stay
 * Active (the portal shows them), so the nightly jobs that act on "every Active client" — the renewal check, the yearly agreement, the installment
 * invoices — must skip them: a dissolving LLC must not be sent a renewal job, a new yearly agreement or an invoice.
 *
 * THROWS on a read error — a money job must stop rather than guess.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CLOSING_WAITS_MARKER } from '@/lib/closure/pending-return'

export async function companiesWaitingForFinalReturn(): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet (lib/job-notes/read.ts)
  const notes = await (supabaseAdmin as any).from('service_delivery_notes').select('service_delivery_id').ilike('body', `%${CLOSING_WAITS_MARKER}%`)
  if (notes.error) throw new Error(`could not read the closing notes: ${notes.error.message}`)
  const jobIds = Array.from(new Set(((notes.data ?? []) as Array<{ service_delivery_id: string }>).map((n) => n.service_delivery_id)))
  if (jobIds.length === 0) return new Set()

  const jobs = await supabaseAdmin.from('service_deliveries').select('account_id').in('id', jobIds).not('account_id', 'is', null)
  if (jobs.error) throw new Error(`could not read the closure jobs: ${jobs.error.message}`)
  const accountIds = Array.from(new Set((jobs.data ?? []).map((j) => (j as { account_id: string }).account_id)))
  if (accountIds.length === 0) return new Set()

  const accounts = await supabaseAdmin.from('accounts').select('id, status').in('id', accountIds)
  if (accounts.error) throw new Error(`could not read the companies: ${accounts.error.message}`)
  return new Set((accounts.data ?? []).filter((a) => String((a as { status: string | null }).status ?? '').toLowerCase() !== 'closed').map((a) => (a as { id: string }).id))
}
