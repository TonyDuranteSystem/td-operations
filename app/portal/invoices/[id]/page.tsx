'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Download, Send, CheckCircle2, Loader2, FileText,
  Calendar, User, Receipt, Clock, Pencil,
} from 'lucide-react'
import { toast } from 'sonner'
import { markInvoiceAsPaid } from '../actions'
import { format, parseISO } from 'date-fns'

interface InvoiceDetail {
  id: string
  invoice_number: string
  status: string
  currency: string
  subtotal: number
  discount: number
  total: number
  issue_date: string
  due_date: string | null
  paid_date: string | null
  notes: string | null
  message: string | null
  created_at: string
  customer: { name: string; email: string | null; address: string | null; vat_number: string | null } | null
  items: { description: string; quantity: number; unit_price: number; amount: number; sort_order: number }[]
}

const STATUS_COLORS: Record<string, string> = {
  Draft: 'bg-zinc-100 text-zinc-700',
  Sent: 'bg-blue-100 text-blue-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

export default function InvoiceDetailPage() {
  const params = useParams()
  const router = useRouter()
  const invoiceId = params.id as string

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState(false)
  const [sending, setSending] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/portal/invoices/${invoiceId}`)
      if (!res.ok) { setLoading(false); return }
      const data = await res.json()
      setInvoice(data)
      setLoading(false)
    }
    load()
  }, [invoiceId])

  const currencySymbol = invoice?.currency === 'EUR' ? '\u20AC' : '$'

  const handleDownloadPDF = async () => {
    setDownloading(true)
    try {
      const res = await fetch(`/api/portal/invoices/${invoiceId}/pdf`)
      if (!res.ok) throw new Error('Failed to generate PDF')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${invoice?.invoice_number ?? 'invoice'}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('PDF downloaded')
    } catch {
      toast.error('Failed to download PDF')
    } finally {
      setDownloading(false)
    }
  }

  const handleSend = async () => {
    if (!invoice?.customer?.email) {
      toast.error('Customer has no email address')
      return
    }
    setSending(true)
    try {
      const res = await fetch(`/api/portal/invoices/${invoiceId}/send`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to send')
      setInvoice(prev => prev ? { ...prev, status: 'Sent' } : prev)
      toast.success(`Invoice sent to ${invoice.customer.email}`)
    } catch {
      toast.error('Failed to send invoice')
    } finally {
      setSending(false)
    }
  }

  const handleMarkPaid = () => {
    startTransition(async () => {
      const result = await markInvoiceAsPaid(invoiceId, new Date().toISOString().split('T')[0])
      if (result.success) {
        setInvoice(prev => prev ? { ...prev, status: 'Paid', paid_date: new Date().toISOString().split('T')[0] } : prev)
        toast.success('Invoice marked as paid')
      } else {
        toast.error(result.error ?? 'Failed to update')
      }
    })
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="p-8 text-center">
        <FileText className="h-12 w-12 mx-auto text-zinc-300 mb-4" />
        <p className="text-zinc-500">Invoice not found</p>
        <Link href="/portal/invoices" className="text-sm text-blue-600 hover:underline mt-2 inline-block">Back to invoices</Link>
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <Link href="/portal/invoices" className="p-2 rounded-lg hover:bg-zinc-100">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{invoice.invoice_number}</h1>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[invoice.status] ?? 'bg-zinc-100 text-zinc-700'}`}>
                {invoice.status}
              </span>
            </div>
            <p className="text-sm text-zinc-500 mt-0.5">Created {fmtDate(invoice.created_at)}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          {invoice.status === 'Draft' && (
            <Link
              href={`/portal/invoices/${invoiceId}/edit`}
              className="flex items-center gap-2 px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
          )}

          <button
            onClick={handleDownloadPDF}
            disabled={downloading}
            className="flex items-center gap-2 px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50 disabled:opacity-50"
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            PDF
          </button>

          {invoice.status === 'Draft' && invoice.customer?.email && (
            <button
              onClick={handleSend}
              disabled={sending}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </button>
          )}

          {(invoice.status === 'Sent' || invoice.status === 'Overdue') && (
            <button
              onClick={handleMarkPaid}
              disabled={isPending}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Mark Paid
            </button>
          )}
        </div>
      </div>

      {/* Invoice Card */}
      <div className="bg-white rounded-xl border shadow-sm">
        {/* Customer + Dates */}
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-6 border-b">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase mb-2">
              <User className="h-3.5 w-3.5" /> Customer
            </div>
            <p className="font-medium text-zinc-900">{invoice.customer?.name ?? '—'}</p>
            {invoice.customer?.email && <p className="text-sm text-zinc-500">{invoice.customer.email}</p>}
            {invoice.customer?.address && <p className="text-sm text-zinc-500 mt-1">{invoice.customer.address}</p>}
            {invoice.customer?.vat_number && <p className="text-sm text-zinc-500">VAT: {invoice.customer.vat_number}</p>}
          </div>
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase mb-1">
                <Calendar className="h-3.5 w-3.5" /> Issue Date
              </div>
              <p className="text-sm text-zinc-900">{fmtDate(invoice.issue_date)}</p>
            </div>
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase mb-1">
                <Clock className="h-3.5 w-3.5" /> Due Date
              </div>
              <p className="text-sm text-zinc-900">{fmtDate(invoice.due_date)}</p>
            </div>
            {invoice.paid_date && (
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase mb-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Paid Date
                </div>
                <p className="text-sm text-emerald-700 font-medium">{fmtDate(invoice.paid_date)}</p>
              </div>
            )}
          </div>
        </div>

        {/* Line Items */}
        <div className="p-6 border-b">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase mb-4">
            <Receipt className="h-3.5 w-3.5" /> Items
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-zinc-500 uppercase">
                <th className="pb-2">Description</th>
                <th className="pb-2 text-right w-20">Qty</th>
                <th className="pb-2 text-right w-28">Price</th>
                <th className="pb-2 text-right w-28">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((item, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-3 text-zinc-900">{item.description}</td>
                    <td className="py-3 text-right text-zinc-600">{item.quantity}</td>
                    <td className="py-3 text-right text-zinc-600">{currencySymbol}{item.unit_price.toFixed(2)}</td>
                    <td className="py-3 text-right font-medium text-zinc-900">{currencySymbol}{item.amount.toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="p-6 flex justify-end">
          <div className="w-64 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Subtotal</span>
              <span>{currencySymbol}{invoice.subtotal.toFixed(2)}</span>
            </div>
            {invoice.discount > 0 && (
              <div className="flex justify-between">
                <span className="text-zinc-500">Discount</span>
                <span className="text-red-600">-{currencySymbol}{invoice.discount.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between pt-2 border-t font-semibold text-lg">
              <span>Total</span>
              <span>{currencySymbol}{invoice.total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Message */}
        {invoice.message && (
          <div className="px-6 pb-6">
            <p className="text-xs font-medium text-zinc-500 uppercase mb-1">Payment Terms</p>
            <p className="text-sm text-zinc-700 whitespace-pre-wrap">{invoice.message}</p>
          </div>
        )}
      </div>

      {/* Internal Notes */}
      {invoice.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-xs font-medium text-amber-700 uppercase mb-1">Internal Notes</p>
          <p className="text-sm text-amber-800">{invoice.notes}</p>
        </div>
      )}
    </div>
  )
}
