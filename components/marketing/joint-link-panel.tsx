'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { whatsappWebLink } from '@/lib/marketing/templates'
import { WA_WINDOW_FEATURES, WA_WINDOW_NAME } from '@/lib/marketing/whatsapp-web'
import { useT } from '@/components/marketing/lang-provider'

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
const firstName = (full: string | null) => (full ?? '').trim().split(/\s+/)[0] ?? ''

interface Props { leadId: string; leadName: string | null; phone: string | null; email: string | null; canAct: boolean; canWhatsApp: boolean; canEmail: boolean }

/**
 * "Link with Antonio" (dev job 0b916784, 1 Nov 2026): the seller makes a booking link that offers only the times when he and Antonio are both free. The client books on the link's own page (no login),
 * gets a Zoom meeting and can cancel or move the call. The message is written in the client's language (the link's) for the seller to change; it goes out by WhatsApp Web (he presses Send there) or by email
 * from his own mailbox, and only then is "booking link sent" written on the lead. Every server answer is shown as the server wrote it.
 */
export function JointLinkPanel({ leadId, leadName, phone, email, canAct, canWhatsApp, canEmail }: Props) {
  const router = useRouter()
  const t = useT()
  const [link, setLink] = useState<{ url: string; lang: 'it' | 'en' } | null>(null)
  const [edited, setEdited] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [emailed, setEmailed] = useState(false)

  const name = firstName(leadName)
  const message = edited ?? (link
    ? link.lang === 'it'
      ? `Ciao${name ? ` ${name}` : ''}, per parlare con Antonio e con me ho aperto per te solo gli orari in cui siamo liberi entrambi. Scegli quello che preferisci qui: ${link.url}`
      : `Hi${name ? ` ${name}` : ''}, to talk with Antonio and me I opened only the times when we are both free. Pick the one you prefer here: ${link.url}`
    : '')
  const wa = link && canWhatsApp ? whatsappWebLink(phone, message) : null

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/joint-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : t('Could not save. Please try again.'))
      return d
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.')); return null } finally { setBusy(false) }
  }

  async function make() {
    const d = await post({ action: 'create' })
    if (d && typeof d.url === 'string') { setLink({ url: d.url, lang: d.lang === 'en' ? 'en' : 'it' }); setEdited(null); setDone(null); setEmailed(false) }
  }
  async function record(via: 'whatsapp' | 'email'): Promise<boolean> {
    if (!link) return false
    const d = await post({ action: 'sent', via, url: link.url })
    if (!d) return false
    router.refresh(); return true
  }
  function openWeb() {
    if (!wa) return
    const w = window.open(wa, WA_WINDOW_NAME, WA_WINDOW_FEATURES)
    if (!w) { setError(t('Your browser blocked the WhatsApp window. Allow pop-ups for this site and try again.')); return }
    w.focus(); setAsking(true)
  }
  async function sendEmail() {
    if (!link || !email) return
    setBusy(true); setError(null)
    try {
      if (!emailed) {
        const boxes = await fetch('/api/marketing/inbox/mailboxes').then(r => (r.ok ? r.json() : null)).catch(() => null)
        const address = (boxes?.mailboxes as Array<{ address: string }> | undefined)?.[0]?.address
        if (!address) throw new Error(t('No mailbox is set up for you yet. Antonio adds one in CRM > Marketing > Settings.'))
        const res = await fetch('/api/marketing/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, mode: 'new', to: email, subject: link.lang === 'it' ? 'Prenota la chiamata con Antonio' : 'Book your call with Antonio', message, sendKey: `joint-${leadId}-${Date.now()}` }) })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('The email could not be sent. Nothing was sent; try again.')) }
        setEmailed(true)
      }
      setBusy(false)
      if (await record('email')) setDone(t('Email sent. It is written on the lead.'))
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('The email could not be sent. Nothing was sent; try again.')) } finally { setBusy(false) }
  }
  async function answer(sent: boolean) {
    if (!sent) { setAsking(false); return }
    if (await record('whatsapp')) { setAsking(false); setDone(t('Recorded. It is written on the lead.')) }
  }

  if (!canAct) return null
  return (
    <section className="rounded-xl border bg-white p-4 text-sm" data-testid="joint-link-panel">
      <h2 className="text-sm font-semibold text-slate-600">{t('Link with Antonio')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('A link that offers only the times when you and Antonio are both free. The client books, gets a Zoom link by email and can cancel or move the call.')}</p>
      <div className="mt-3 space-y-2">
        {!link && <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy} onClick={make} data-testid="joint-make">{t('Make the link')}</button>}
        {link && (
          <>
            <label className="block"><span className="text-slate-500">{t('Message text')}</span>
              <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={4} value={message} onChange={e => setEdited(e.target.value)} data-testid="joint-message" />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={`${btn} bg-emerald-600 text-white`} disabled={busy || !wa} onClick={openWeb} data-testid="joint-whatsapp">{t('Send by WhatsApp')}</button>
              <button type="button" className={btn} disabled={busy || !canEmail || !email} onClick={sendEmail} data-testid="joint-email">{t('Send by email')}</button>
              <button type="button" className={btn} disabled={busy} onClick={make} data-testid="joint-new">{t('Make a new link')}</button>
            </div>
            {!canWhatsApp && <p className="text-xs text-slate-500">{t('You do not have access to WhatsApp. Ask your team owner.')}</p>}
            {canWhatsApp && !phone && <p className="text-xs text-slate-500">{t('No phone number to write to.')}</p>}
            {!email && <p className="text-xs text-slate-500">{t('This lead has no email address.')}</p>}
          </>
        )}
        {asking && (
          <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3" data-testid="joint-did-you-send">
            <p className="font-semibold text-emerald-900">{t('Did you send it?')}</p>
            <p className="text-xs text-emerald-800">{t('This only writes the note on the lead. "No" writes nothing.')}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" className={`${btn} bg-emerald-600 text-white`} disabled={busy} onClick={() => answer(true)} data-testid="joint-sent-yes">{t('Yes, sent')}</button>
              <button type="button" className={btn} disabled={busy} onClick={() => answer(false)} data-testid="joint-sent-no">{t('No')}</button>
            </div>
          </div>
        )}
        {done && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800" data-testid="joint-done">{done}</p>}
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="joint-error">{error}</p>}
    </section>
  )
}
