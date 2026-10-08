'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Info, Loader2 } from 'lucide-react'
import type { SendNotice } from '@/lib/portal/invoice-send-notices'

/**
 * The permanent notices on an invoice before it is sent (dev job 1a23f5f1). They replace a message
 * that faded away after a few seconds and offered no way to fix the problem. Which notices appear is
 * decided by lib/portal/invoice-send-notices.ts (locked in code); the words come from the portal
 * dictionary through `t`.
 */
export function InvoiceSendNotices({
  notices,
  t,
  onSaveEmail,
  confirmingSendAnyway,
  onSendAnyway,
  onCancelSendAnyway,
  sending,
}: {
  notices: SendNotice[]
  t: (key: string) => string
  onSaveEmail: (email: string) => Promise<boolean>
  confirmingSendAnyway: boolean
  onSendAnyway: () => void
  onCancelSendAnyway: () => void
  sending: boolean
}) {
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)

  if (notices.length === 0) return null
  const has = (id: SendNotice['id']) => notices.some(n => n.id === id)

  return (
    <div className="space-y-3" data-testid="invoice-send-notices">
      {has('draft-explainer') && (
        <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" data-notice="draft-explainer">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <p>{t('invoices.draftExplainer')}</p>
        </div>
      )}

      {has('no-customer-email') && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-3" data-notice="no-customer-email">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{t('invoices.noEmailBanner')}</p>
          </div>
          <form
            className="flex flex-col sm:flex-row gap-2"
            onSubmit={async e => {
              e.preventDefault()
              setSaving(true)
              const ok = await onSaveEmail(email)
              setSaving(false)
              if (ok) setEmail('')
            }}
          >
            <input
              id="invoice-customer-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('invoices.emailPlaceholder')}
              className="flex-1 min-w-0 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-zinc-900"
              required
            />
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('invoices.saveEmail')}
            </button>
          </form>
        </div>
      )}

      {has('no-payment-details') && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-3" data-notice="no-payment-details">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{t('invoices.noPaymentBanner')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/portal/profile"
              className="inline-flex items-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
            >
              {t('invoices.addPaymentDetails')}
            </Link>
            {confirmingSendAnyway && (
              <>
                <button
                  type="button"
                  onClick={onSendAnyway}
                  disabled={sending}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  {sending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('invoices.sendAnyway')}
                </button>
                <button
                  type="button"
                  onClick={onCancelSendAnyway}
                  className="inline-flex items-center rounded-lg px-4 py-2 text-sm text-amber-900 hover:bg-amber-100"
                >
                  {t('invoices.notYet')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
