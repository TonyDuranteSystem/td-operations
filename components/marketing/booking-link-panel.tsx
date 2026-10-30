'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { whatsappWebLink } from '@/lib/marketing/templates'
import { WA_WINDOW_FEATURES, WA_WINDOW_NAME } from '@/lib/marketing/whatsapp-web'
import { useT } from '@/components/marketing/lang-provider'
import type { CalendlyLink } from '@/lib/marketing/settings-schema'

const REMEMBER_KEY = 'tdm_booking_link'
const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
const isHttps = (u: string) => /^https:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(u.trim())
const firstName = (full: string | null) => (full ?? '').trim().split(/\s+/)[0] ?? ''

interface Props {
  leadId: string
  leadName: string | null
  /** null when the person may not see phone numbers or the lead has none */
  phone: string | null
  email: string | null
  /** the link last sent on this lead, if any */
  lastLink: string | null
  canAct: boolean
  canWhatsApp: boolean
  canEmail: boolean
  /** the seller's saved links (Settings: Team page, "Calendly links"): when there are some, he picks one instead of typing; none = the old typed, remembered link */
  links?: CalendlyLink[]
}

/**
 * Rocco's booking link (27 Oct 2026): once a lead has PAID he sends his own calendar link (Calendly) so the lead books the consultation. The link is typed or pasted here (it is remembered
 * for the next lead), the message is written for him to change, and it goes out by WhatsApp Web (he presses Send there, like every WhatsApp in this workspace) or by email from his own mailbox.
 * Sending records "Booking link sent" on the lead, which moves it to that column. Every server answer is shown as the server wrote it.
 */
export function BookingLinkPanel({ leadId, leadName, phone, email, lastLink, canAct, canWhatsApp, canEmail, links = [] }: Props) {
  const router = useRouter()
  const t = useT()
  const [url, setUrl] = useState(lastLink ?? '')
  // a saved link the last message used stays chosen; otherwise the first saved link
  const [picked, setPicked] = useState<string | null>(links.find(l => l.url === lastLink)?.id ?? links[0]?.id ?? null)
  const saved = links.find(l => l.id === picked) ?? null
  const [edited, setEdited] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  // the email went out but the note on the lead failed: the next press only records it, it never sends a second email
  const [emailed, setEmailed] = useState<string | null>(null)

  const hasLinks = links.length > 0
  useEffect(() => {
    if (lastLink || hasLinks) return
    try { const saved = window.localStorage.getItem(REMEMBER_KEY); if (saved) setUrl(saved) } catch { /* the remembered link is only a convenience */ }
  }, [lastLink, hasLinks])

  const chosen = saved ? saved.url : url.trim()
  const message = edited ?? t('Hi {name}, thank you for your payment! Choose a day and time for your consultation here: {link}', { name: firstName(leadName), link: chosen })
  const link = canWhatsApp && isHttps(chosen) ? whatsappWebLink(phone, message) : null
  const remember = () => { if (saved) return; try { window.localStorage.setItem(REMEMBER_KEY, url.trim()) } catch { /* convenience only */ } }

  async function record(via: 'whatsapp' | 'email'): Promise<boolean> {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'booking_link', url: chosen, via }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.')) }
      remember()
      router.refresh()
      return true
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
      return false
    } finally { setBusy(false) }
  }

  function openWeb() {
    if (!link) return
    const w = window.open(link, WA_WINDOW_NAME, WA_WINDOW_FEATURES)
    if (!w) { setError(t('Your browser blocked the WhatsApp window. Allow pop-ups for this site and try again.')); return }
    w.focus()
    setAsking(true)
  }

  async function sendEmail() {
    if (!email) return
    setBusy(true); setError(null)
    try {
      if (emailed !== chosen) {
        const boxes = await fetch('/api/marketing/inbox/mailboxes').then(r => (r.ok ? r.json() : null)).catch(() => null)
        const address = (boxes?.mailboxes as Array<{ address: string }> | undefined)?.[0]?.address
        if (!address) throw new Error(t('No mailbox is set up for you yet. Antonio adds one in CRM > Marketing > Settings.'))
        const res = await fetch('/api/marketing/inbox/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, mode: 'new', to: email, subject: t('Book your consultation'), message, sendKey: `booking-${leadId}-${Date.now()}` }),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('The email could not be sent. Nothing was sent; try again.')) }
        setEmailed(chosen)
      }
      setBusy(false)
      if (await record('email')) setDone(t('Email sent. The lead is now under "Booking link sent".'))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('The email could not be sent. Nothing was sent; try again.'))
    } finally { setBusy(false) }
  }

  async function answer(sent: boolean) {
    if (!sent) { setAsking(false); return }
    if (await record('whatsapp')) { setAsking(false); setDone(t('Recorded. The lead is now under "Booking link sent".')) }
  }

  return (
    <section className="rounded-xl border bg-white p-4 text-sm" data-testid="booking-link-panel">
      <h2 className="text-sm font-semibold text-slate-600">{t('Booking link')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('After the lead has paid, send your calendar link so the lead books the consultation.')}</p>
      {canAct && (
        <div className="mt-3 space-y-2">
          {links.length > 0 ? (
            <div data-testid="booking-links">
              <p className="text-slate-500">{t('Which link?')}</p>
              <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label={t('Which link?')}>
                {links.map(l => <button key={l.id} type="button" role="radio" aria-checked={picked === l.id} onClick={() => { setPicked(l.id); setEdited(null) }} data-testid="booking-link-choice" className={`${btn} ${picked === l.id ? 'border-slate-900 bg-slate-900 text-white' : ''}`}>{l.name}</button>)}
              </div>
              {saved && <p className="mt-1 text-xs text-slate-500" data-testid="booking-link-url">{saved.url}</p>}
            </div>
          ) : (
            <>
              <label className="block">
                <span className="text-slate-500">{t('Your calendar link (Calendly)')}</span>
                <input type="url" inputMode="url" className="mt-1 w-full rounded-lg border px-3 py-2" value={url} onChange={e => { setUrl(e.target.value); setEdited(null) }} placeholder="https://calendly.com/…" data-testid="booking-url" />
              </label>
              {url.trim() !== '' && !isHttps(url) && <p className="text-xs text-amber-800">{t('Use a link that starts with https://')}</p>}
            </>
          )}
          <label className="block">
            <span className="text-slate-500">{t('Message text')}</span>
            <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={4} value={message} onChange={e => setEdited(e.target.value)} data-testid="booking-message" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${btn} bg-emerald-600 text-white`} disabled={busy || !link} onClick={openWeb} data-testid="booking-whatsapp">{t('Send by WhatsApp')}</button>
            <button type="button" className={btn} disabled={busy || !canEmail || !email || !isHttps(chosen)} onClick={sendEmail} data-testid="booking-email">{t('Send by email')}</button>
          </div>
          {!canWhatsApp && <p className="text-xs text-slate-500">{t('You do not have access to WhatsApp. Ask your team owner.')}</p>}
          {canWhatsApp && !phone && <p className="text-xs text-slate-500">{t('No phone number to write to.')}</p>}
          {!email && <p className="text-xs text-slate-500">{t('This lead has no email address.')}</p>}
          {asking && (
            <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3" data-testid="booking-did-you-send">
              <p className="font-semibold text-emerald-900">{t('Did you send it?')}</p>
              <p className="text-xs text-emerald-800">{t('This only writes the note on the lead. "No" writes nothing.')}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={`${btn} bg-emerald-600 text-white`} disabled={busy} onClick={() => answer(true)} data-testid="booking-sent-yes">{t('Yes, sent')}</button>
                <button type="button" className={btn} disabled={busy} onClick={() => answer(false)} data-testid="booking-sent-no">{t('No')}</button>
              </div>
            </div>
          )}
          {done && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800" data-testid="booking-done">{done}</p>}
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </section>
  )
}
