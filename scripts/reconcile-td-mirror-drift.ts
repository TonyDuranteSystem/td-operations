/* eslint-disable no-console -- CLI tool, stdout IS the UI */
/**
 * Reconcile client_expenses mirror drift for TD invoices.
 *
 * `payments` is the source of truth; `client_expenses` (source='td_invoice') is
 * a projection. Historic scattered partial-writes let the two drift (a credit
 * applied to an invoice reduced the payment but not the client's copy — Giuseppe
 * INV-002233: payment $700, mirror stuck at $1,150). This sweep re-projects every
 * drifted mirror from its payment via the authoritative syncTDInvoiceMirror.
 *
 * Idempotent + safe to re-run. DRY-RUN by default; pass --apply to write.
 *
 * `--open-only` restricts to invoices the client is still acting on (Sent /
 * Overdue / Partial) — where a stale mirror shows a WRONG balance the client
 * can see. Paid/Cancelled drift is cosmetically invisible (client correctly
 * sees "Paid" / nothing owed), so the targeted repair skips that churn.
 *
 * Usage:
 *   npx tsx scripts/reconcile-td-mirror-drift.ts                        # dry run, all drift
 *   npx tsx scripts/reconcile-td-mirror-drift.ts --open-only           # dry run, open invoices only
 *   npx tsx scripts/reconcile-td-mirror-drift.ts --apply --open-only   # heal the client-visible ones
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 * The supabase-admin guard blocks pointing this at production locally — run the
 * production sweep from the deployed server (or with prod creds Antonio provides).
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.local') })

async function main() {
  const apply = process.argv.includes('--apply')
  const openOnly = process.argv.includes('--open-only')
  const OPEN = new Set(['Sent', 'Overdue', 'Partial'])
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const { syncTDInvoiceMirror, mapPaymentStatusToExpense, mirrorDiffers } = await import('@/lib/portal/td-invoice-mirror')

  // Pull every TD-invoice mirror + its payment, find drift with the SAME rule
  // the sync uses, so the report matches exactly what would change.
  const { data: rows } = await supabaseAdmin
    .from('client_expenses')
    .select('td_payment_id, total, amount_due, amount_paid, status, paid_date, invoice_number, payments:td_payment_id(total, amount, amount_due, amount_paid, status, invoice_status, paid_date)')
    .eq('source', 'td_invoice')
    .not('td_payment_id', 'is', null)

  type Row = {
    td_payment_id: string; invoice_number: string | null
    total: number | null; amount_due: number | null; amount_paid: number | null; status: string | null; paid_date: string | null
    payments: { total: number | null; amount: number | null; amount_due: number | null; amount_paid: number | null; status: string | null; invoice_status: string | null; paid_date: string | null } | null
  }
  const all = ((rows ?? []) as unknown as Row[])
    .filter((r) => !openOnly || (r.payments && OPEN.has(r.payments.invoice_status ?? r.payments.status ?? '')))

  const projectAfter = (p: NonNullable<Row['payments']>) => {
    const status = mapPaymentStatusToExpense(p.invoice_status ?? p.status)
    const settled = status === 'Paid' || status === 'Cancelled'
    return {
      total: Number(p.total ?? p.amount ?? 0),
      amount_due: settled ? 0 : Number(p.amount_due ?? 0),
      amount_paid: Number(p.amount_paid ?? 0),
      status,
      paid_date: p.paid_date ?? null,
    }
  }
  const drifted = all.filter((r) => r.payments && mirrorDiffers(r, projectAfter(r.payments)))

  console.log(`TD mirrors: ${all.length} | drifted: ${drifted.length} | mode: ${apply ? 'APPLY' : 'DRY-RUN'}`)
  for (const r of drifted) {
    const p = r.payments!
    console.log(
      `${(r.invoice_number ?? r.td_payment_id).padEnd(20)} ` +
      `mirror[total=${r.total} due=${r.amount_due} status=${r.status}] → ` +
      `payment[total=${p.total} due=${p.amount_due} status=${mapPaymentStatusToExpense(p.invoice_status ?? p.status)}]`,
    )
  }

  if (!apply) { console.log('\nDry run — pass --apply to heal.'); return }

  let healed = 0
  for (const r of drifted) {
    const res = await syncTDInvoiceMirror(r.td_payment_id, supabaseAdmin)
    if (res.changed) healed++
  }
  console.log(`\n✅ Healed ${healed} mirror row(s).`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
