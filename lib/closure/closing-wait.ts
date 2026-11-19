/**
 * Which companies are waiting for their final tax return before they close (dev job 0a60f416, part C).
 *
 * A company waits while its closure job is finished at "Closing" and the newest marker on it says it waits (lib/closure/pending-return.ts), and the company
 * is not Closed yet. These companies stay Active (the portal shows them), so the nightly jobs that act on "every Active client" — the renewal check, the annual
 * report check, the yearly agreement, the installment invoices, the deadline reminders, the renewal-status watchdog — must skip them: a dissolving LLC must
 * not be sent a renewal job, a new yearly agreement or an invoice.
 *
 * THROWS on a read error — a money job must stop rather than guess.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CLOSING_MARKER_LIKE, isWaitingClosureJob } from '@/lib/closure/pending-return'

export interface WaitingClosure {
  accountId: string
  closureJobId: string
}

export async function findWaitingClosures(): Promise<WaitingClosure[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet (lib/job-notes/read.ts)
  const notes = await (supabaseAdmin as any).from('service_delivery_notes').select('service_delivery_id, body').ilike('body', CLOSING_MARKER_LIKE).order('created_at', { ascending: true })
  if (notes.error) throw new Error(`could not read the closing notes: ${notes.error.message}`)
  const byJob = new Map<string, Array<{ body: string | null }>>()
  for (const n of (notes.data ?? []) as Array<{ service_delivery_id: string; body: string | null }>) {
    const list = byJob.get(n.service_delivery_id) ?? []
    list.push({ body: n.body })
    byJob.set(n.service_delivery_id, list)
  }
  if (byJob.size === 0) return []

  const jobs = await supabaseAdmin.from('service_deliveries').select('id, account_id, status, stage').in('id', Array.from(byJob.keys())).not('account_id', 'is', null)
  if (jobs.error) throw new Error(`could not read the closure jobs: ${jobs.error.message}`)
  const waitingJobs = ((jobs.data ?? []) as Array<{ id: string; account_id: string; status: string | null; stage: string | null }>).filter((j) => isWaitingClosureJob(j, byJob.get(j.id) ?? []))
  if (waitingJobs.length === 0) return []

  const accounts = await supabaseAdmin.from('accounts').select('id, status').in('id', Array.from(new Set(waitingJobs.map((j) => j.account_id))))
  if (accounts.error) throw new Error(`could not read the companies: ${accounts.error.message}`)
  const open = new Set((accounts.data ?? []).filter((a) => String((a as { status: string | null }).status ?? '').toLowerCase() !== 'closed').map((a) => (a as { id: string }).id))
  return waitingJobs.filter((j) => open.has(j.account_id)).map((j) => ({ accountId: j.account_id, closureJobId: j.id }))
}

export async function companiesWaitingForFinalReturn(): Promise<Set<string>> {
  return new Set((await findWaitingClosures()).map((w) => w.accountId))
}
