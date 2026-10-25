'use client'

import { useState } from 'react'

type TFn = (text: string, vars?: Record<string, string | number>) => string
interface Preview { to: string; from: string; replyTo: string | null; subject: string; html: string; lang: 'en' | 'it'; alreadyEmailedAt: string | null }

const same: TFn = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text)

/**
 * TD Marketing — "Send invitation email" (dev job 9aec66fa). Under a freshly made invitation link: the person presses the button, SEES the exact email (an isolated frame, no scripts) and
 * presses Send now. Nothing leaves before that. The link stays available to copy. Used in the CRM Teams page (English) and in the workspace Team screen (`t` = the person's language).
 */
export function InviteEmailPanel({ url, endpoint, t = same }: { url: string; endpoint: string; t?: TFn }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [sent, setSent] = useState<{ to: string; from: string; warning?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const token = (() => { try { return new URL(url).searchParams.get('token') ?? '' } catch { return '' } })()

  async function call(send: boolean, fallback: string, lang?: 'en' | 'it'): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null)
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, send, lang }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : fallback)
      return d
    } catch (e) { setError(e instanceof Error && e.message ? e.message : fallback); return null } finally { setBusy(false) }
  }
  async function showPreview(lang?: 'en' | 'it') {
    const d = await call(false, t('Could not prepare the email. Please try again, or copy the link.'), lang)
    if (d) setPreview(d as unknown as Preview)
  }
  async function send() {
    const d = await call(true, t('The email could not be sent. Please try again, or copy the link.'), preview?.lang)
    if (d) { setSent({ to: String(d.to), from: preview?.from ?? '', warning: typeof d.warning === 'string' ? d.warning : undefined }); setPreview(null) }
  }
  const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
  if (sent) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800" role="status" data-testid="invite-email-sent">
        {t('Sent to {to} from {from}. The invitation now says "emailed".', { to: sent.to, from: sent.from })}{sent.warning ? ` ${sent.warning}` : ''}
      </div>
    )
  }
  return (
    <div className="mt-3" data-testid="invite-email-panel">
      {!preview && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || !token} onClick={() => showPreview()} data-testid="invite-email-open">&#9993; {t('Send invitation email')}</button>
          <span className="text-xs text-slate-500">{t('You see the email first. Nothing is sent until you press Send.')}</span>
        </div>
      )}
      {preview && (
        <div className="rounded-lg border bg-white p-3" data-testid="invite-email-preview">
          <p className="mb-2 text-xs text-slate-500">{t('This is exactly what will be sent:')}</p>
          <dl className="mb-2 grid grid-cols-[96px_1fr] gap-y-0.5 text-sm">
            <dt className="text-slate-500">{t('From')}</dt><dd>{preview.from}</dd>
            <dt className="text-slate-500">{t('To')}</dt><dd data-testid="invite-email-to">{preview.to}</dd>
            {preview.replyTo && <><dt className="text-slate-500">{t('Replies go to')}</dt><dd data-testid="invite-email-replyto">{preview.replyTo}</dd></>}
            <dt className="text-slate-500">{t('Subject')}</dt><dd data-testid="invite-email-subject">{preview.subject}</dd>
            <dt className="text-slate-500">{t('Language')}</dt>
            <dd className="flex gap-1">
              {(['it', 'en'] as const).map(l => (
                <button key={l} type="button" disabled={busy || preview.lang === l} data-testid={`invite-email-lang-${l}`} onClick={() => showPreview(l)}
                  className={`rounded border px-2 text-xs ${preview.lang === l ? 'bg-slate-900 text-white' : ''}`}>{l === 'it' ? t('Italian') : t('English')}</button>
              ))}
            </dd>
          </dl>
          <iframe title={t('Email preview')} sandbox="" srcDoc={preview.html} className="h-[330px] w-full rounded-lg border bg-white" data-testid="invite-email-frame" />
          {preview.alreadyEmailedAt && <p className="mt-2 text-sm text-amber-800" role="status">{t('This invitation was already emailed. Make a new link to send it again.')}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || !!preview.alreadyEmailedAt} onClick={send} data-testid="invite-email-send">{t('Send now')}</button>
            <button type="button" className={btn} disabled={busy} onClick={() => setPreview(null)}>{t('Cancel')}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="invite-email-error">{error}</p>}
    </div>
  )
}
