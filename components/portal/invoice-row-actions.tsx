'use client'

/**
 * Per-row INLINE action icons for the client portal Fatture (Invoices) Sales
 * list. The actions sit directly on the row (next to the status) so the client
 * sees them without opening a menu. Reuses the EXISTING backend:
 *   • Download PDF → GET  /api/portal/invoices/[id]/pdf   (any status)
 *   • Edit         → /portal/invoices/[id]/edit
 *   • Send         → POST /api/portal/invoices/[id]/send  (Draft only)
 *   • Reminder     → POST /api/portal/invoices/[id]/remind (Sent/Overdue)
 *   • Void         → voidInvoice() server action (confirm dialog)
 *
 * View (the eye) is rendered by the list row itself. Which status-dependent
 * actions appear is gated by availableInvoiceActions(status).
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Download, Pencil, Send, Bell, Ban, Loader2, X } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { availableInvoiceActions } from '@/lib/portal/invoice-row-actions-policy'
import { voidInvoice } from '@/app/portal/invoices/actions'

interface InvoiceRowActionsInput {
  id: string
  invoice_number: string
  status: string
}

export function InvoiceRowActions({ invoice }: { invoice: InvoiceRowActionsInput }) {
  const router = useRouter()
  const { t } = useLocale()
  const [isPending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)

  const actions = availableInvoiceActions(invoice.status)
  const disabled = busy || isPending
  const iconBtn = 'p-1.5 rounded-lg transition-colors disabled:opacity-40'

  const postAction = async (path: 'send' | 'remind') => {
    setBusy(true)
    try {
      const res = await fetch(`/api/portal/invoices/${invoice.id}/${path}`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t('invoices.actionFailed'))
      }
      toast.success(path === 'send' ? t('invoices.sent') : t('invoices.reminderSent'))
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('invoices.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleDownloadPdf = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/portal/invoices/${invoice.id}/pdf`)
      if (!res.ok) {
        const ct = res.headers.get('content-type') || ''
        const d = ct.includes('json') ? await res.json().catch(() => ({})) : {}
        throw new Error(d.error || t('invoices.pdfFailed'))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${invoice.invoice_number || 'invoice'}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(t('invoices.pdfDownloaded'))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('invoices.pdfFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleVoid = () => {
    startTransition(async () => {
      const result = await voidInvoice(invoice.id)
      if (result.success) {
        setVoidOpen(false)
        toast.success(t('invoices.voided'))
        router.refresh()
      } else {
        toast.error(result.error ?? t('invoices.actionFailed'))
      }
    })
  }

  return (
    <div className="flex items-center justify-end gap-0.5">
      {/* Download PDF — every status */}
      <button
        type="button"
        onClick={handleDownloadPdf}
        disabled={disabled}
        title={t('invoices.downloadPdf')}
        aria-label={t('invoices.downloadPdf')}
        className={`${iconBtn} text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </button>

      {actions.includes('edit') && (
        <button
          type="button"
          onClick={() => router.push(`/portal/invoices/${invoice.id}/edit`)}
          disabled={disabled}
          title={t('invoices.edit')}
          aria-label={t('invoices.edit')}
          className={`${iconBtn} text-zinc-400 hover:text-blue-600 hover:bg-blue-50`}
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}

      {actions.includes('send') && (
        <button
          type="button"
          onClick={() => postAction('send')}
          disabled={disabled}
          title={t('invoices.send')}
          aria-label={t('invoices.send')}
          className={`${iconBtn} text-blue-500 hover:text-blue-700 hover:bg-blue-50`}
        >
          <Send className="h-4 w-4" />
        </button>
      )}

      {actions.includes('remind') && (
        <button
          type="button"
          onClick={() => postAction('remind')}
          disabled={disabled}
          title={t('invoices.remind')}
          aria-label={t('invoices.remind')}
          className={`${iconBtn} text-amber-500 hover:text-amber-700 hover:bg-amber-50`}
        >
          <Bell className="h-4 w-4" />
        </button>
      )}

      {actions.includes('void') && (
        <button
          type="button"
          onClick={() => setVoidOpen(true)}
          disabled={disabled}
          title={t('invoices.void')}
          aria-label={t('invoices.void')}
          className={`${iconBtn} text-red-400 hover:text-red-600 hover:bg-red-50`}
        >
          <Ban className="h-4 w-4" />
        </button>
      )}

      {/* Void confirmation */}
      {voidOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setVoidOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-red-700">{t('invoices.voidConfirmTitle')}</h3>
              <button onClick={() => setVoidOpen(false)} className="p-1 hover:bg-zinc-100 rounded">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-zinc-600 mb-4">
              <strong>{invoice.invoice_number}</strong> — {t('invoices.voidConfirmDesc')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setVoidOpen(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
              >
                {t('invoices.cancel')}
              </button>
              <button
                onClick={handleVoid}
                disabled={isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                {t('invoices.void')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
