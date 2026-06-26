'use client'

/**
 * Per-row action menu for the client portal Fatture (Invoices) Sales list.
 *
 * Brings Send / Reminder / Edit / Void inline so the client doesn't have to
 * open the detail page. Reuses the EXISTING backend:
 *   • Send   → POST /api/portal/invoices/[id]/send
 *   • Remind → POST /api/portal/invoices/[id]/remind
 *   • Edit   → /portal/invoices/[id]/edit
 *   • Void   → voidInvoice() server action
 *
 * Visibility is gated by availableInvoiceActions(status). Same 3-dot +
 * createPortal flip-above pattern as the CRM PaymentRowActions / LeadRowActions.
 */

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MoreVertical, Eye, Download, Pencil, Send, Bell, Ban, Loader2, X } from 'lucide-react'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  const actions = availableInvoiceActions(invoice.status)

  // Close on outside click.
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const positionMenu = () => {
    if (!buttonRef.current) return
    const btn = buttonRef.current.getBoundingClientRect()
    const menuWidth = 200
    const menuHeight = Math.max(menuRef.current?.offsetHeight ?? 0, 200)
    const gap = 4
    const margin = 8

    let top = btn.bottom + gap
    let left = btn.right - menuWidth

    if (top + menuHeight + margin > window.innerHeight) {
      const flippedTop = btn.top - menuHeight - gap
      top = flippedTop >= margin ? flippedTop : Math.max(margin, window.innerHeight - menuHeight - margin)
    }
    if (left + menuWidth + margin > window.innerWidth) {
      left = window.innerWidth - menuWidth - margin
    }
    if (left < margin) left = margin

    setMenuPos({ top, left })
  }

  useLayoutEffect(() => {
    if (!menuOpen) return
    positionMenu()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const handler = () => positionMenu()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler stable enough
  }, [menuOpen])

  // --- Action handlers ---

  const postAction = async (path: 'send' | 'remind') => {
    setMenuOpen(false)
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
    setMenuOpen(false)
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

  const itemClass = 'flex items-center gap-2 w-full px-3 py-2 text-sm text-left'

  const menuPortal = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={menuPos
            ? { position: 'fixed', top: menuPos.top, left: menuPos.left, visibility: 'visible' }
            : { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}
          className="z-[100] w-[200px] bg-white border rounded-lg shadow-lg overflow-hidden"
          role="menu"
        >
          <button
            type="button"
            onClick={() => { setMenuOpen(false); router.push(`/portal/invoices/${invoice.id}`) }}
            className={`${itemClass} text-zinc-700 hover:bg-zinc-50`}
          >
            <Eye className="h-4 w-4" /> {t('invoices.view')}
          </button>

          <button
            type="button"
            onClick={handleDownloadPdf}
            className={`${itemClass} text-zinc-700 hover:bg-zinc-50`}
          >
            <Download className="h-4 w-4" /> {t('invoices.downloadPdf')}
          </button>

          {actions.includes('edit') && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); router.push(`/portal/invoices/${invoice.id}/edit`) }}
              className={`${itemClass} text-zinc-700 hover:bg-zinc-50`}
            >
              <Pencil className="h-4 w-4" /> {t('invoices.edit')}
            </button>
          )}

          {actions.includes('send') && (
            <button
              type="button"
              onClick={() => postAction('send')}
              className={`${itemClass} text-blue-700 hover:bg-blue-50`}
            >
              <Send className="h-4 w-4" /> {t('invoices.send')}
            </button>
          )}

          {actions.includes('remind') && (
            <button
              type="button"
              onClick={() => postAction('remind')}
              className={`${itemClass} text-amber-700 hover:bg-amber-50`}
            >
              <Bell className="h-4 w-4" /> {t('invoices.remind')}
            </button>
          )}

          {actions.includes('void') && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setVoidOpen(true) }}
              className={`${itemClass} text-red-600 hover:bg-red-50 border-t`}
            >
              <Ban className="h-4 w-4" /> {t('invoices.void')}
            </button>
          )}
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o) }}
        disabled={busy || isPending}
        className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 transition-colors disabled:opacity-50"
        title={t('invoices.rowActions')}
        aria-label={t('invoices.rowActions')}
      >
        {busy || isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
      </button>
      {menuPortal}

      {/* Void confirmation */}
      {voidOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setVoidOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
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
    </>
  )
}
