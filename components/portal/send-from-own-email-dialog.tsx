'use client'

import { useState } from 'react'
import { X, Download, Mail, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { interpolateString } from '@/lib/template-interpolation'
import { buildMailtoUrl } from '@/lib/portal/invoice-mailto'
import { markInvoiceSentManually } from '@/app/portal/invoices/actions'

interface Props {
  invoiceId: string
  invoiceNumber: string
  status: string
  companyName: string
  customerName: string
  customerEmail: string | null
  total: string // already formatted with its currency symbol
  dueDate: string | null
  message: string | null
  onClose: () => void
  onSent: () => void
}

/**
 * Send the invoice from the client's OWN email program. Three small steps: download the PDF, open the prepared message,
 * and (for a Draft) confirm it was sent so the invoice moves to Sent. Works with any email provider, Proton included.
 */
export function SendFromOwnEmailDialog(p: Props) {
  const { t } = useLocale()
  const [downloading, setDownloading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const isDraft = p.status === 'Draft'

  const subject = interpolateString(t('invMail.subject'), { number: p.invoiceNumber, company: p.companyName })
  const body = interpolateString(t('invMail.body'), {
    customer: p.customerName,
    number: p.invoiceNumber,
    total: p.total,
    due: p.dueDate ? interpolateString(t('invMail.due'), { date: p.dueDate }) : '',
    terms: p.message ? `\n\n${p.message}` : '',
    company: p.companyName,
  })
  const mailto = buildMailtoUrl({ to: p.customerEmail, subject, body })

  const download = async () => {
    setDownloading(true)
    try {
      // as=Sent: a Draft is shown as it will look once sent (no DRAFT stamp), nothing is written to the invoice.
      const res = await fetch(`/api/portal/invoices/${p.invoiceId}/pdf?as=Sent`)
      if (!res.ok) throw new Error(`${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `${p.invoiceNumber}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error(t('invDetail.pdfFailed'))
    } finally {
      setDownloading(false)
    }
  }

  const confirmSent = async () => {
    setConfirming(true)
    try {
      const r = await markInvoiceSentManually(p.invoiceId)
      if (!r.success) throw new Error(r.error)
      toast.success(t('invMail.markedSent'))
      p.onSent()
      p.onClose()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('invMail.markFailed'))
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="send-own-email-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={p.onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-zinc-900">{t('invMail.title')}</h3>
          <button onClick={p.onClose} aria-label={t('common.cancel')} className="p-1 hover:bg-zinc-100 rounded"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-zinc-500 mb-4">{t('invMail.intro')}</p>

        <ol className="space-y-3 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span><strong>1.</strong> {t('invMail.step1')}</span>
            <button onClick={download} disabled={downloading} className="flex items-center gap-1.5 px-3 py-1.5 border rounded-lg hover:bg-zinc-50 disabled:opacity-50 shrink-0">
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {t('invoices.pdf')}
            </button>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span><strong>2.</strong> {t('invMail.step2')}</span>
            <a href={mailto} className="flex items-center gap-1.5 px-3 py-1.5 border rounded-lg hover:bg-zinc-50 shrink-0" data-testid="send-own-email-open">
              <Mail className="h-4 w-4" />
              {t('invMail.open')}
            </a>
          </li>
          {isDraft && (
            <li className="flex items-center justify-between gap-3">
              <span><strong>3.</strong> {t('invMail.step3')}</span>
              <button onClick={confirmSent} disabled={confirming} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 shrink-0">
                {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {t('invMail.iSentIt')}
              </button>
            </li>
          )}
        </ol>
        {!p.customerEmail && <p className="mt-3 text-xs text-amber-700">{t('invMail.noEmail')}</p>}
      </div>
    </div>
  )
}
