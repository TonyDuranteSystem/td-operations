'use client'

import { useState } from 'react'
import { Download, Loader2, CreditCard } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'

interface Payment {
  id: string
  description: string | null
  amount: number
  amount_currency: string | null
  period: string | null
  year: number | null
  due_date: string | null
  paid_date: string | null
  status: string | null
  installment: string | null
  invoice_number: string | null
  invoice_status: string | null
}

const STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-green-100 text-green-700',
  Pending: 'bg-yellow-100 text-yellow-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

function formatCurrency(amount: number, currency?: string | null): string {
  const c = currency ?? 'USD'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(amount)
}

export function PaymentHistory({ payments, title }: { payments: Payment[]; title: string }) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const handleDownload = async (p: Payment) => {
    setDownloadingId(p.id)
    try {
      const res = await fetch(`/api/portal/payments/${p.id}/pdf`)
      if (!res.ok) throw new Error('Failed to generate PDF')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${p.invoice_number ?? 'invoice'}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('PDF downloaded')
    } catch {
      toast.error('Failed to download PDF')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
      <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{title}</h2>
      {payments.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-zinc-400">
          <CreditCard className="h-8 w-8 mb-2" />
          <p className="text-sm">No payments yet</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {payments.slice(0, 8).map(p => {
            const hasInvoice = !!p.invoice_number && !!p.invoice_status
            const isDownloading = downloadingId === p.id
            return (
              <div key={p.id} className="flex items-center justify-between py-2 border-b last:border-b-0 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate text-xs">{p.description ?? (`${p.period ?? ''} ${p.year ?? ''}`.trim() || '\u2014')}</p>
                  <p className="text-xs text-zinc-500">{p.due_date ? formatDate(p.due_date) : '\u2014'}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {hasInvoice && (
                    <button
                      onClick={() => handleDownload(p)}
                      disabled={isDownloading}
                      className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
                      title={`Download ${p.invoice_number}`}
                    >
                      {isDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[p.status ?? ''] ?? 'bg-zinc-100')}>
                    {p.status}
                  </span>
                  <span className="text-xs font-medium">{formatCurrency(p.amount, p.amount_currency)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
