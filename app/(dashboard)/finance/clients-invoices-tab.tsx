'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, FileText, Plus, Send, Bell, Download, CheckCircle,
  ChevronRight, Clock, CreditCard, Receipt, History,
  DollarSign, AlertTriangle, SplitSquareHorizontal, Users, RefreshCw, ScrollText,
  Ban, Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { InvoiceDialog } from '@/components/payments/invoice-dialog'
import { InvoiceNoteDot } from '@/components/payments/invoice-note-dot'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  createUnifiedInvoiceDraft,
  sendNewInvoice,
  voidInvoice,
  voidInvoicePreview,
  reactivateInvoice,
  reactivateInvoicePreview,
} from './actions'

interface ClientSummary {
  id: string
  company_name: string
  total_invoiced: number
  total_paid: number
  outstanding: number
  overdue: number
  invoice_count: number
  overdue_count: number
  has_partial: boolean
}

interface Props {
  clientList: ClientSummary[]
  selectedClientId: string | null
  invoices: Array<Record<string, unknown>>
  creditNotes: Array<Record<string, unknown>>
  auditLog: Array<Record<string, unknown>>
  paymentHistory: Array<Record<string, unknown>>
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    Paid: 'bg-green-100 text-green-800',
    Sent: 'bg-blue-100 text-blue-800',
    Overdue: 'bg-red-100 text-red-800',
    Partial: 'bg-orange-100 text-orange-800',
    Draft: 'bg-gray-100 text-gray-600',
    Split: 'bg-purple-100 text-purple-800',
    Voided: 'bg-gray-100 text-gray-500 line-through',
    Credit: 'bg-emerald-100 text-emerald-800',
    Available: 'bg-emerald-100 text-emerald-800',
    Applied: 'bg-zinc-100 text-zinc-600',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

function clientHealthIndicator(c: ClientSummary) {
  if (c.overdue > 0) return 'bg-red-500'
  if (c.has_partial) return 'bg-orange-400'
  if (c.outstanding > 0) return 'bg-blue-500'
  if (c.invoice_count > 0) return 'bg-green-500'
  return 'bg-gray-300'
}

function csym(currency?: string) {
  return currency === 'EUR' ? '\u20AC' : '$'
}

export function ClientsInvoicesTab({ clientList, selectedClientId, invoices, creditNotes, auditLog, paymentHistory }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [showSection, setShowSection] = useState<'invoices' | 'statement' | 'credits' | 'payments' | 'audit'>('invoices')
  const [showNewInvoice, setShowNewInvoice] = useState(false)

  const filteredClients = useMemo(() => {
    if (!search) return clientList.filter(c => c.invoice_count > 0 || c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)
    const q = search.toLowerCase()
    return clientList.filter(c => c.company_name.toLowerCase().includes(q))
  }, [clientList, search])

  const selectedClient = clientList.find(c => c.id === selectedClientId)

  // Statement of account — a chronological ledger interleaving invoices (charges)
  // and payments received (money in) by transaction date, with a running balance.
  // Pure composition of the invoices + paymentHistory already passed as props.
  const statement = useMemo(() => {
    type Ev = {
      date: string | null
      sortKey: number
      desc: string
      ref: string | null
      refId: string | null
      charge: number
      moneyIn: number
    }
    const evs: Ev[] = []
    for (const inv of invoices) {
      const d = (inv.issue_date as string) ?? null
      evs.push({
        date: d,
        sortKey: d ? Date.parse(d) : Number.POSITIVE_INFINITY, // undated entries sort last
        desc: 'Invoice issued',
        ref: (inv.invoice_number as string) ?? null,
        refId: (inv.id as string) ?? null,
        charge: Number(inv.total ?? 0),
        moneyIn: 0,
      })
    }
    for (const p of paymentHistory) {
      const amt = Number(p.amount_paid ?? p.amount ?? 0)
      if (amt <= 0) continue
      const d = (p.paid_date as string) ?? null
      const method = (p.payment_method as string) ?? ''
      evs.push({
        date: d,
        sortKey: d ? Date.parse(d) : Number.POSITIVE_INFINITY,
        desc: method ? `Payment received (${method})` : 'Payment received',
        ref: (p.invoice_number as string) ?? null,
        refId: (p.id as string) ?? null,
        charge: 0,
        moneyIn: amt,
      })
    }
    // Stable sort by date asc → on a tie, invoices (pushed first) precede payments,
    // so a same-day charge appears before the payment that settles it.
    evs.sort((a, b) => a.sortKey - b.sortKey)
    let bal = 0
    const rows = evs.map(e => {
      bal += e.charge - e.moneyIn
      return { ...e, balance: bal }
    })
    const totalCharged = rows.reduce((s, r) => s + r.charge, 0)
    const totalIn = rows.reduce((s, r) => s + r.moneyIn, 0)
    const sym = csym(invoices.find(i => i.currency)?.currency as string | undefined)
    return { rows, totalCharged, totalIn, balanceDue: totalCharged - totalIn, sym }
  }, [invoices, paymentHistory])

  function selectClient(id: string) {
    router.push(`/finance?tab=clients&client=${id}`)
  }

  // Void / Reactivate open a preview dialog rather than acting on click.
  // One dialog for the whole table, pointed at the row the operator picked.
  const [voidTarget, setVoidTarget] = useState<{ id: string; number: string } | null>(null)
  const [reactivateTarget, setReactivateTarget] = useState<{ id: string; number: string } | null>(null)

  /**
   * Every row on this tab is a TD invoice (a `payments` row — see finance/page.tsx,
   * which maps `invoice_status` → `status`). Until 2026-07-10 these actions called
   * the CLIENT's own sales-invoice endpoints (`/api/portal/invoices/...`,
   * `markInvoiceAsPaid`), which look up `client_invoices` by id. With a payments
   * id they matched nothing: Download and Send errored, Remind silently re-sent
   * the whole invoice, and Mark Paid updated ZERO rows while still toasting
   * "Invoice marked as paid" — a false success. All four now use the same TD
   * routines the All Invoices tab uses. Do not point this tab at portal routes.
   */
  async function invoiceAction(action: string, invoiceId: string) {
    try {
      if (action === 'pdf') {
        window.open(`/api/invoices/${invoiceId}/pdf`, '_blank')
        return
      }
      if (action === 'send') {
        const result = await sendNewInvoice(invoiceId)
        if (!result.success) throw new Error(result.error)
        toast.success('Invoice sent')
        router.refresh()
        return
      }
      if (action === 'remind') {
        const { sendInvoiceReminder } = await import('./actions')
        const result = await sendInvoiceReminder(invoiceId)
        if (!result.success) throw new Error(result.error)
        toast.success('Reminder sent')
        router.refresh()
        return
      }
      if (action === 'markPaid') {
        const { markInvoicePaid } = await import('./actions')
        const result = await markInvoicePaid(invoiceId)
        if (!result.success) throw new Error(result.error)
        toast.success('Invoice marked as paid')
        router.refresh()
        return
      }
      if (action === 'regenerate') {
        const { regenerateInvoice } = await import('@/app/(dashboard)/payments/invoice-actions')
        const result = await regenerateInvoice(invoiceId)
        if (!result.success) throw new Error(result.error)
        const applied = (result.data?.applied_credit as number) ?? 0
        const mirrorSynced = (result.data?.mirror_synced as boolean) ?? false
        if (applied > 0) {
          toast.success('Invoice regenerated — applied credit now shown as a line')
          router.refresh()
        } else if (mirrorSynced) {
          // No NEW credit, but the client-portal copy was out of sync and is now corrected.
          toast.success('Client portal copy synced to this invoice')
          router.refresh()
        } else {
          toast.info('No available credit to apply — client copy already in sync')
        }
        return
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    }
  }

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* Left panel: Client list — full width + capped height on mobile, fixed sidebar on desktop */}
      <div className="w-full lg:w-80 border-b lg:border-r flex flex-col bg-muted/30 max-h-56 lg:max-h-none shrink-0">
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search clients..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-md border text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredClients.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground text-center">No clients found</p>
          )}
          {filteredClients.map(c => (
            <button
              key={c.id}
              onClick={() => selectClient(c.id)}
              className={`w-full text-left px-4 py-3 border-b hover:bg-muted/50 transition-colors ${
                selectedClientId === c.id ? 'bg-blue-50 border-l-2 border-l-blue-600' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full shrink-0 ${clientHealthIndicator(c)}`} />
                <span className="font-medium text-sm truncate">{c.company_name}</span>
              </div>
              <div className="flex items-center justify-between mt-1 ml-4">
                <span className="text-xs text-muted-foreground">{c.invoice_count} invoice{c.invoice_count !== 1 ? 's' : ''}</span>
                {c.outstanding > 0 && (
                  <span className={`text-xs font-medium ${c.overdue > 0 ? 'text-red-600' : 'text-blue-600'}`}>
                    ${c.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel: Selected client detail */}
      <div className="flex-1 overflow-y-auto">
        {!selectedClient ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Users className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">Select a client</p>
              <p className="text-sm">Choose a client from the list to see their invoices</p>
            </div>
          </div>
        ) : (
          <div className="p-6">
            {/* Client header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-semibold">{selectedClient.company_name}</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {selectedClient.invoice_count} invoice{selectedClient.invoice_count !== 1 ? 's' : ''}
                  {selectedClient.overdue_count > 0 && <span className="text-red-600"> &middot; {selectedClient.overdue_count} overdue</span>}
                </p>
              </div>
              <button
                onClick={() => setShowNewInvoice(true)}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Plus className="w-4 h-4" />
                New Invoice
              </button>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><FileText className="w-3 h-3" /> Invoiced</p>
                <p className="text-lg font-bold mt-1">${selectedClient.total_invoiced.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Paid</p>
                <p className="text-lg font-bold text-green-600 mt-1">${selectedClient.total_paid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> Outstanding</p>
                <p className="text-lg font-bold text-blue-600 mt-1">${selectedClient.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Overdue</p>
                <p className="text-lg font-bold text-red-600 mt-1">${selectedClient.overdue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
              </div>
            </div>

            {/* Section tabs */}
            <div className="flex gap-1 mb-4 border-b">
              {([
                { id: 'invoices', label: 'Invoices', icon: FileText, count: invoices.length },
                { id: 'statement', label: 'Statement', icon: ScrollText, count: statement.rows.length },
                { id: 'credits', label: 'Credit Notes', icon: Receipt, count: creditNotes.length },
                { id: 'payments', label: 'Payment History', icon: CreditCard, count: paymentHistory.length },
                { id: 'audit', label: 'Activity', icon: History, count: auditLog.length },
              ] as const).map(s => (
                <button
                  key={s.id}
                  onClick={() => setShowSection(s.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                    showSection === s.id
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <s.icon className="w-3.5 h-3.5" />
                  {s.label}
                  {s.count > 0 && <span className="text-xs bg-muted rounded-full px-1.5">{s.count}</span>}
                </button>
              ))}
            </div>

            {/* Invoice list */}
            {showSection === 'invoices' && (
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-4 py-2.5 font-medium">Invoice</th>
                      <th className="text-left px-4 py-2.5 font-medium">Date</th>
                      <th className="text-left px-4 py-2.5 font-medium">Due</th>
                      <th className="text-right px-4 py-2.5 font-medium">Total</th>
                      <th className="text-right px-4 py-2.5 font-medium">Paid</th>
                      <th className="text-right px-4 py-2.5 font-medium">Balance</th>
                      <th className="text-left px-4 py-2.5 font-medium">Status</th>
                      <th className="text-right px-4 py-2.5 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.length === 0 && (
                      <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">No invoices yet</td></tr>
                    )}
                    {invoices.map((inv) => {
                      const status = inv.status as string
                      const id = inv.id as string
                      const total = Number(inv.total ?? 0)
                      const amountPaid = Number(inv.amount_paid ?? 0)
                      const amountDue = Number(inv.amount_due ?? total)
                      const currency = inv.currency as string | undefined
                      const sym = csym(currency)

                      return (
                        <tr key={id} className="border-b hover:bg-muted/30">
                          <td className="px-4 py-2.5 font-medium">
                            <div className="flex items-center gap-1.5">
                              {inv.parent_invoice_id && <SplitSquareHorizontal className="w-3 h-3 text-purple-500" />}
                              <FastTooltip label="Open invoice PDF" align="left">
                                <a
                                  href={`/api/invoices/${id}/pdf`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline font-mono"
                                  aria-label="Open invoice PDF"
                                >
                                  {inv.invoice_number as string}
                                </a>
                              </FastTooltip>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{(inv.issue_date as string) ?? '—'}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{(inv.due_date as string) ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right">{sym}{total.toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right text-green-600">{amountPaid > 0 ? `${sym}${amountPaid.toFixed(2)}` : '—'}</td>
                          <td className="px-4 py-2.5 text-right font-medium">
                            {status === 'Paid' ? '—' : <span className={amountDue > 0 ? 'text-red-600' : ''}>{sym}{amountDue.toFixed(2)}</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            {statusBadge(status)}
                            <InvoiceNoteDot note={inv.notes as string | null} className="ml-1" />
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              <FastTooltip label="Download PDF">
                                <button onClick={() => invoiceAction('pdf', id)} aria-label="Download PDF" className="p-1 rounded hover:bg-muted">
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                              </FastTooltip>
                              {['Draft', 'Sent'].includes(status) && (
                                <FastTooltip label="Send">
                                  <button onClick={() => invoiceAction('send', id)} aria-label="Send" className="p-1 rounded hover:bg-muted">
                                    <Send className="w-3.5 h-3.5" />
                                  </button>
                                </FastTooltip>
                              )}
                              {['Sent', 'Overdue'].includes(status) && (
                                <FastTooltip label="Remind">
                                  <button onClick={() => invoiceAction('remind', id)} aria-label="Remind" className="p-1 rounded hover:bg-muted">
                                    <Bell className="w-3.5 h-3.5" />
                                  </button>
                                </FastTooltip>
                              )}
                              {['Sent', 'Overdue', 'Partial'].includes(status) && (
                                <FastTooltip label="Mark Paid">
                                  <button onClick={() => invoiceAction('markPaid', id)} aria-label="Mark Paid" className="p-1 rounded hover:bg-blue-100 text-blue-600">
                                    <CheckCircle className="w-3.5 h-3.5" />
                                  </button>
                                </FastTooltip>
                              )}
                              {['Draft', 'Sent', 'Overdue', 'Partial'].includes(status) && (
                                <FastTooltip label="Regenerate — show an applied credit as a line">
                                  <button onClick={() => invoiceAction('regenerate', id)} aria-label="Regenerate — show an applied credit as a line" className="p-1 rounded hover:bg-indigo-100 text-indigo-600">
                                    <RefreshCw className="w-3.5 h-3.5" />
                                  </button>
                                </FastTooltip>
                              )}
                              {['Draft', 'Sent', 'Overdue', 'Partial'].includes(status) && (
                                <FastTooltip label="Void — cancel this invoice">
                                  <button onClick={() => setVoidTarget({ id, number: inv.invoice_number as string })} aria-label="Void — cancel this invoice" className="p-1 rounded hover:bg-red-100 text-red-500">
                                    <Ban className="w-3.5 h-3.5" />
                                  </button>
                                </FastTooltip>
                              )}
                              {status === 'Cancelled' && (
                                <FastTooltip label="Reactivate — bring this cancelled invoice back to life">
                                  <button onClick={() => setReactivateTarget({ id, number: inv.invoice_number as string })} aria-label="Reactivate — bring this cancelled invoice back to life" className="p-1 rounded hover:bg-emerald-100 text-emerald-600">
                                    <Undo2 className="w-3.5 h-3.5" />
                                  </button>
                                </FastTooltip>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Statement of account — chronological charges + money in, running balance */}
            {showSection === 'statement' && (
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-4 py-2.5 font-medium">Date</th>
                      <th className="text-left px-4 py-2.5 font-medium">Description</th>
                      <th className="text-right px-4 py-2.5 font-medium">Charge</th>
                      <th className="text-right px-4 py-2.5 font-medium">Money In</th>
                      <th className="text-right px-4 py-2.5 font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.rows.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No transactions yet</td></tr>
                    )}
                    {statement.rows.map((e, i) => (
                      <tr key={i} className="border-b hover:bg-muted/30">
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{e.date ?? '—'}</td>
                        <td className="px-4 py-2.5">
                          <span>{e.desc}</span>{' '}
                          {e.ref && e.refId ? (
                            <FastTooltip label="Open invoice PDF">
                              <a
                                href={`/api/invoices/${e.refId}/pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline font-mono"
                                aria-label="Open invoice PDF"
                              >
                                {e.ref}
                              </a>
                            </FastTooltip>
                          ) : e.ref ? (
                            <span className="font-mono">{e.ref}</span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2.5 text-right">{e.charge > 0 ? `${statement.sym}${e.charge.toFixed(2)}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-green-600">{e.moneyIn > 0 ? `${statement.sym}${e.moneyIn.toFixed(2)}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-medium">{statement.sym}{e.balance.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {statement.rows.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 bg-muted/40 font-semibold">
                        <td className="px-4 py-2.5" colSpan={2}>Totals</td>
                        <td className="px-4 py-2.5 text-right">{statement.sym}{statement.totalCharged.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-green-600">{statement.sym}{statement.totalIn.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={statement.balanceDue > 0 ? 'text-red-600' : ''}>{statement.sym}{statement.balanceDue.toFixed(2)}</span>
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}

            {/* Credit Notes — payments rows with invoice_status='Credit' (CN- numbers).
                "Available" = credit_remaining still unspent; apply it to an open
                invoice with that invoice's Regenerate button. */}
            {showSection === 'credits' && (
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-4 py-2.5 font-medium">Credit Note</th>
                      <th className="text-right px-4 py-2.5 font-medium">Amount</th>
                      <th className="text-right px-4 py-2.5 font-medium">Remaining</th>
                      <th className="text-left px-4 py-2.5 font-medium">Reason</th>
                      <th className="text-left px-4 py-2.5 font-medium">Status</th>
                      <th className="text-left px-4 py-2.5 font-medium">Applied To</th>
                      <th className="text-left px-4 py-2.5 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditNotes.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No credit notes</td></tr>
                    )}
                    {creditNotes.map(cn => {
                      const sym = csym(cn.currency as string | undefined)
                      const remaining = Number(cn.remaining ?? 0)
                      const appliedToId = cn.applied_to_invoice_id as string | null
                      const appliedInv = appliedToId ? invoices.find(i => (i.id as string) === appliedToId) : null
                      return (
                        <tr key={cn.id as string} className="border-b hover:bg-muted/30">
                          <td className="px-4 py-2.5 font-medium font-mono">{(cn.credit_note_number as string) ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right text-green-600">{sym}{Number(cn.amount ?? 0).toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right font-medium">{remaining > 0 ? `${sym}${remaining.toFixed(2)}` : '—'}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{(cn.reason as string) ?? '—'}</td>
                          <td className="px-4 py-2.5">{statusBadge(cn.status as string)}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {appliedInv ? (appliedInv.invoice_number as string) : appliedToId ? 'Applied' : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{((cn.created_at as string) ?? '').split('T')[0]}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Payment History */}
            {showSection === 'payments' && (
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-4 py-2.5 font-medium">Invoice</th>
                      <th className="text-left px-4 py-2.5 font-medium">Date</th>
                      <th className="text-right px-4 py-2.5 font-medium">Amount</th>
                      <th className="text-left px-4 py-2.5 font-medium">Method</th>
                      <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentHistory.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No payment history</td></tr>
                    )}
                    {paymentHistory.map(p => (
                      <tr key={p.id as string} className="border-b hover:bg-muted/30">
                        <td className="px-4 py-2.5 font-medium">
                          {p.invoice_number ? (
                            <FastTooltip label="Open invoice PDF" align="left">
                              <a
                                href={`/api/invoices/${p.id as string}/pdf`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline font-mono"
                                aria-label="Open invoice PDF"
                              >
                                {p.invoice_number as string}
                              </a>
                            </FastTooltip>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{(p.paid_date as string) ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right">${Number(p.amount_paid ?? p.amount ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{(p.payment_method as string) ?? '—'}</td>
                        <td className="px-4 py-2.5">{statusBadge((p.invoice_status ?? p.status) as string)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Audit Trail */}
            {showSection === 'audit' && (
              <div className="space-y-2">
                {auditLog.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">No activity recorded yet</p>
                )}
                {auditLog.map(entry => {
                  const action = entry.action as string
                  const performedAt = ((entry.performed_at as string) ?? '').replace('T', ' ').slice(0, 19)
                  const performedBy = entry.performed_by as string
                  const newValues = entry.new_values as Record<string, unknown> | null
                  const invoiceId = entry.invoice_id as string

                  // Find invoice number for this entry
                  const inv = invoices.find(i => (i.id as string) === invoiceId)
                  const invNum = inv ? (inv.invoice_number as string) : invoiceId.slice(0, 8)

                  return (
                    <div key={entry.id as string} className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-muted/30">
                      <div className="mt-0.5">
                        {action === 'created' && <Plus className="w-4 h-4 text-blue-500" />}
                        {action === 'paid' && <CheckCircle className="w-4 h-4 text-green-500" />}
                        {action === 'partial_payment' && <DollarSign className="w-4 h-4 text-orange-500" />}
                        {action === 'status_changed' && <ChevronRight className="w-4 h-4 text-gray-500" />}
                        {action === 'edited' && <FileText className="w-4 h-4 text-gray-500" />}
                        {action === 'split' && <SplitSquareHorizontal className="w-4 h-4 text-purple-500" />}
                        {action === 'credit_applied' && <Receipt className="w-4 h-4 text-green-500" />}
                        {!['created', 'paid', 'partial_payment', 'status_changed', 'edited', 'split', 'credit_applied'].includes(action) && <ChevronRight className="w-4 h-4 text-gray-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">
                          <span className="font-medium">{invNum}</span>
                          {' '}
                          <span className="text-muted-foreground">
                            {action === 'created' && 'created'}
                            {action === 'paid' && 'marked as paid'}
                            {action === 'partial_payment' && `partial payment of $${Number(newValues?.amount_paid ?? 0).toFixed(2)}`}
                            {action === 'status_changed' && `status changed to ${newValues?.status ?? '?'}`}
                            {action === 'edited' && 'edited'}
                            {action === 'split' && `split into ${newValues?.installments ?? '?'} installments`}
                            {action === 'credit_applied' && `credit of $${Number(newValues?.credit_amount ?? 0).toFixed(2)} applied`}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {performedAt} &middot; {performedBy}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {/* New Invoice Dialog — uses unified system (writes to BOTH client_invoices + payments) */}
      <InvoiceDialog
        open={showNewInvoice}
        onClose={() => {
          setShowNewInvoice(false)
          router.refresh()
        }}
        onCreateInvoice={async (input) => {
          const result = await createUnifiedInvoiceDraft({
            account_id: input.account_id,
            description: input.description,
            currency: (input.amount_currency || 'USD') as 'USD' | 'EUR',
            due_date: input.due_date,
            issue_date: input.issue_date,
            message: input.message,
            payment_method: input.payment_method,
            bank_preference: input.bank_preference,
            items: input.items,
            mark_as_paid: input.mark_as_paid,
            installment: input.installment,
          })
          // duplicate_warning is toasted once, centrally, by InvoiceDialog's own
          // handleSubmit — toasting it here too produced a stacked double warning
          // (bug-hunter finding, 2026-09-01).
          return result
        }}
        onSendInvoice={async (paymentId) => {
          return await sendNewInvoice(paymentId)
        }}
      />

      <ConfirmDestructiveDialog
        open={!!voidTarget}
        onClose={() => setVoidTarget(null)}
        title="Void Invoice"
        description={`Void invoice ${voidTarget?.number ?? ''}?`}
        severity="red"
        loadPreview={async () => {
          const r = await voidInvoicePreview(voidTarget!.id)
          if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
          return r.preview
        }}
        confirmLabel="Void Invoice"
        onConfirm={async () => {
          const result = await voidInvoice(voidTarget!.id)
          if (!result.success) return { success: false, error: result.error ?? 'Failed' }
          router.refresh()
          return { success: true, message: `${voidTarget?.number} voided` }
        }}
      />

      <ConfirmDestructiveDialog
        open={!!reactivateTarget}
        onClose={() => setReactivateTarget(null)}
        title="Reactivate Invoice"
        description={`Bring ${reactivateTarget?.number ?? ''} back as a live invoice?`}
        severity="amber"
        loadPreview={async () => {
          const r = await reactivateInvoicePreview(reactivateTarget!.id)
          if (!r.success || !r.preview) throw new Error(r.error ?? 'Preview unavailable')
          return r.preview
        }}
        confirmLabel="Reactivate Invoice"
        onConfirm={async () => {
          const result = await reactivateInvoice(reactivateTarget!.id)
          if (!result.success) return { success: false, error: result.error ?? 'Failed' }
          router.refresh()
          return { success: true, message: `${reactivateTarget?.number} reactivated as ${result.data?.invoice_status ?? 'open'}` }
        }}
      />
    </div>
  )
}
