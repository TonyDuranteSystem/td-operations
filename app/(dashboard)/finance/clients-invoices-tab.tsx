'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, FileText, Plus, Send, Bell, Download, CheckCircle,
  ChevronRight, Clock, CreditCard, Receipt, History,
  DollarSign, AlertTriangle, SplitSquareHorizontal, Users,
} from 'lucide-react'
import { toast } from 'sonner'

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
  const [showSection, setShowSection] = useState<'invoices' | 'credits' | 'payments' | 'audit'>('invoices')

  const filteredClients = useMemo(() => {
    if (!search) return clientList.filter(c => c.invoice_count > 0 || c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)
    const q = search.toLowerCase()
    return clientList.filter(c => c.company_name.toLowerCase().includes(q))
  }, [clientList, search])

  const selectedClient = clientList.find(c => c.id === selectedClientId)

  function selectClient(id: string) {
    router.push(`/finance?tab=clients&client=${id}`)
  }

  async function invoiceAction(action: string, invoiceId: string) {
    try {
      if (action === 'pdf') {
        window.open(`/api/portal/invoices/${invoiceId}/pdf`, '_blank')
        return
      }
      if (action === 'send') {
        const res = await fetch(`/api/portal/invoices/${invoiceId}/send`, { method: 'POST' })
        if (!res.ok) throw new Error(await res.text())
        toast.success('Invoice sent')
        router.refresh()
        return
      }
      if (action === 'remind') {
        const res = await fetch(`/api/portal/invoices/${invoiceId}/send`, { method: 'POST' })
        if (!res.ok) throw new Error(await res.text())
        toast.success('Reminder sent')
        router.refresh()
        return
      }
      if (action === 'markPaid') {
        const { markInvoiceAsPaid } = await import('@/app/portal/invoices/actions')
        const today = new Date().toISOString().split('T')[0]
        const result = await markInvoiceAsPaid(invoiceId, today)
        if (!result.success) throw new Error(result.error)
        toast.success('Invoice marked as paid')
        router.refresh()
        return
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    }
  }

  return (
    <div className="flex h-full">
      {/* Left panel: Client list */}
      <div className="w-80 border-r flex flex-col bg-muted/30">
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
              <a
                href={`/finance?tab=clients&client=${selectedClientId}`}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Plus className="w-4 h-4" />
                New Invoice
              </a>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-4 gap-3 mb-6">
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
              <div className="rounded-lg border overflow-hidden">
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
                              {inv.invoice_number as string}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{(inv.issue_date as string) ?? '—'}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{(inv.due_date as string) ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right">{sym}{total.toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right text-green-600">{amountPaid > 0 ? `${sym}${amountPaid.toFixed(2)}` : '—'}</td>
                          <td className="px-4 py-2.5 text-right font-medium">
                            {status === 'Paid' ? '—' : <span className={amountDue > 0 ? 'text-red-600' : ''}>{sym}{amountDue.toFixed(2)}</span>}
                          </td>
                          <td className="px-4 py-2.5">{statusBadge(status)}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => invoiceAction('pdf', id)} title="Download PDF" className="p-1 rounded hover:bg-muted">
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              {['Draft', 'Sent'].includes(status) && (
                                <button onClick={() => invoiceAction('send', id)} title="Send" className="p-1 rounded hover:bg-muted">
                                  <Send className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {['Sent', 'Overdue'].includes(status) && (
                                <button onClick={() => invoiceAction('remind', id)} title="Remind" className="p-1 rounded hover:bg-muted">
                                  <Bell className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {['Sent', 'Overdue', 'Partial'].includes(status) && (
                                <button onClick={() => invoiceAction('markPaid', id)} title="Mark Paid" className="p-1 rounded hover:bg-blue-100 text-blue-600">
                                  <CheckCircle className="w-3.5 h-3.5" />
                                </button>
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

            {/* Credit Notes */}
            {showSection === 'credits' && (
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-4 py-2.5 font-medium">Credit Note</th>
                      <th className="text-right px-4 py-2.5 font-medium">Amount</th>
                      <th className="text-left px-4 py-2.5 font-medium">Reason</th>
                      <th className="text-left px-4 py-2.5 font-medium">Status</th>
                      <th className="text-left px-4 py-2.5 font-medium">Applied To</th>
                      <th className="text-left px-4 py-2.5 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditNotes.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No credit notes</td></tr>
                    )}
                    {creditNotes.map(cn => (
                      <tr key={cn.id as string} className="border-b hover:bg-muted/30">
                        <td className="px-4 py-2.5 font-medium">{cn.credit_note_number as string}</td>
                        <td className="px-4 py-2.5 text-right text-green-600">${Number(cn.amount ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{(cn.reason as string) ?? '—'}</td>
                        <td className="px-4 py-2.5">{statusBadge(cn.status as string)}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{(cn.applied_to_invoice_id as string) ? 'Applied' : '—'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{((cn.created_at as string) ?? '').split('T')[0]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Payment History */}
            {showSection === 'payments' && (
              <div className="rounded-lg border overflow-hidden">
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
                        <td className="px-4 py-2.5 font-medium">{(p.invoice_number as string) ?? '—'}</td>
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
    </div>
  )
}
