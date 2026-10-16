'use client'

import { useState } from 'react'
import Link from 'next/link'
import { X, Send, Download, Pencil, Eye, Plus, List, Loader2, CalendarClock } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { interpolateString } from '@/lib/template-interpolation'
import { turnInvoiceCreatedPopupOff } from '@/lib/portal/invoice-created-popup'

interface Props {
  invoiceId: string
  invoiceNumber: string
  status: string
  customerEmail: string | null
  nextRecurringDate: string | null
  sending: boolean
  downloading: boolean
  onSend: () => void
  onDownload: () => void
  onClose: () => void
}

/**
 * Shown right after a client creates an invoice, so every option is in front of them instead of hidden behind the
 * small "view" icon (Antonio 2026-10-17). It only offers things the invoice page already does; the page owns the logic.
 */
export function InvoiceCreatedDialog(p: Props) {
  const { t } = useLocale()
  const [dontShow, setDontShow] = useState(false)
  const isDraft = p.status === 'Draft'

  const close = () => {
    if (dontShow) turnInvoiceCreatedPopupOff()
    p.onClose()
  }

  const row = 'flex items-center gap-3 w-full px-4 py-3 text-left text-sm border rounded-lg hover:bg-zinc-50'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="invoice-created-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-semibold text-zinc-900 text-lg">{interpolateString(t('invCreated.title'), { number: p.invoiceNumber })}</h3>
          <button onClick={close} aria-label={t('common.cancel')} className="p-1 hover:bg-zinc-100 rounded"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-zinc-500 mb-4">{t('invCreated.subtitle')}</p>

        <div className="space-y-2">
          {isDraft && (
            <button onClick={p.onSend} disabled={p.sending} className={`${row} bg-blue-600 text-white hover:bg-blue-700 border-blue-600`} data-testid="invoice-created-send">
              {p.sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span>{p.customerEmail ? interpolateString(t('invCreated.send'), { email: p.customerEmail }) : t('invCreated.sendNoEmail')}</span>
            </button>
          )}
          <button onClick={p.onDownload} disabled={p.downloading} className={row}>
            {p.downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span>
              {t('invCreated.pdf')}
              {isDraft && <span className="block text-xs text-zinc-400">{t('invCreated.pdfDraftNote')}</span>}
            </span>
          </button>
          {isDraft && (
            <Link href={`/portal/invoices/${p.invoiceId}/edit`} className={row}>
              <Pencil className="h-4 w-4" /><span>{t('invCreated.edit')}</span>
            </Link>
          )}
          <button onClick={close} className={row}>
            <Eye className="h-4 w-4" /><span>{t('invCreated.view')}</span>
          </button>
          <Link href="/portal/invoices/new" className={row}>
            <Plus className="h-4 w-4" /><span>{t('invCreated.another')}</span>
          </Link>
          <Link href="/portal/invoices" className={row}>
            <List className="h-4 w-4" /><span>{t('invCreated.list')}</span>
          </Link>
        </div>

        {p.nextRecurringDate && (
          <p className="mt-4 flex items-center gap-2 text-xs text-zinc-500" data-testid="invoice-created-recurring">
            <CalendarClock className="h-4 w-4 shrink-0" />
            {interpolateString(t('invCreated.nextRecurring'), { date: p.nextRecurringDate })}
          </p>
        )}

        <label className="mt-4 flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
          <input type="checkbox" checked={dontShow} onChange={e => setDontShow(e.target.checked)} />
          {t('invCreated.dontShow')}
        </label>
      </div>
    </div>
  )
}
