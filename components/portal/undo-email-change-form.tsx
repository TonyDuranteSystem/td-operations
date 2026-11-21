'use client'

import { useState } from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'
import { MustReadBlock } from '@/components/portal/must-read-block'
import { cn } from '@/lib/utils'

/**
 * The "This wasn't me" page (dev job beb43385, step 2): opened from the red button in the note sent to the OLD address after a
 * login-email change. The person is NOT logged in, so the words cannot come from the portal's language provider; the language rides
 * on the link (?lang=) and, when the link is valid, on the contact. The single-use link is the proof, so the form only asks for a new
 * password — which also ends every open session of that login, putting a stranger out.
 */
type Lang = 'en' | 'it'

const COPY = {
  en: {
    title: 'We will put your old email back',
    intro: 'Your login email goes back to {email}. Choose a new password so nobody else can get in.',
    newPassword: 'New password',
    repeat: 'Repeat the new password',
    min: 'Minimum 8 characters',
    readTitle: 'Read well before proceeding.',
    readStrong: 'The new email stops working as a login.',
    readBody: 'Your login email goes back to {email}. You will need the new password the next time you log in.',
    iReadIt: 'I read it',
    tick: 'Tick "I read it" to continue.',
    button: 'Put my old email back',
    working: 'Working...',
    successTitle: 'Done',
    success: 'Your login email is {email} again, with your new password. We told our team, and we will write to you if we need anything.',
    login: 'Log in',
    bad: 'This link has already been used or has expired. Write to support@tonydurante.us and we will help.',
    short: 'The password must be at least 8 characters.',
    mismatch: 'The two passwords are not the same.',
    email_unavailable: "We can't put your old email back because someone else uses it now. Write to support@tonydurante.us and we will help.",
    failed: 'Something went wrong. Please try again, or write to support@tonydurante.us.',
    rate_limited: 'Too many tries. Please wait a moment and try again.',
  },
  it: {
    title: 'Rimetteremo la tua vecchia email',
    intro: 'La tua email di accesso torna a {email}. Scegli una nuova password così nessun altro può entrare.',
    newPassword: 'Nuova password',
    repeat: 'Ripeti la nuova password',
    min: 'Minimo 8 caratteri',
    readTitle: 'Leggi bene prima di continuare.',
    readStrong: 'La nuova email smette di funzionare per accedere.',
    readBody: 'La tua email di accesso torna a {email}. Ti servirà la nuova password al prossimo accesso.',
    iReadIt: 'Ho letto',
    tick: 'Spunta "Ho letto" per continuare.',
    button: 'Rimetti la mia vecchia email',
    working: 'Un attimo...',
    successTitle: 'Fatto',
    success: 'La tua email di accesso è di nuovo {email}, con la tua nuova password. Abbiamo avvisato il nostro team e ti scriveremo se ci serve qualcosa.',
    login: 'Accedi',
    bad: 'Questo link è già stato usato oppure è scaduto. Scrivi a support@tonydurante.us e ti aiutiamo.',
    short: 'La password deve avere almeno 8 caratteri.',
    mismatch: 'Le due password non coincidono.',
    email_unavailable: 'Non possiamo rimettere la tua vecchia email perché ora la usa qualcun altro. Scrivi a support@tonydurante.us e ti aiutiamo.',
    failed: 'Qualcosa è andato storto. Riprova, oppure scrivi a support@tonydurante.us.',
    rate_limited: 'Troppi tentativi. Aspetta un attimo e riprova.',
  },
} as const

export function UndoEmailChangeForm({ token, lang, restoreEmail }: { token: string; lang: Lang; restoreEmail: string | null }) {
  const c = COPY[lang]
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [read, setRead] = useState(false)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneEmail, setDoneEmail] = useState<string | null>(null)
  const fill = (s: string, email: string) => s.replace('{email}', email)

  const submit = async () => {
    setTried(true)
    setError(null)
    if (password.length < 8) { setError(c.short); return }
    if (password !== repeat) { setError(c.mismatch); return }
    if (!read) return
    setBusy(true)
    try {
      const res = await fetch('/api/portal/undo-email-change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password, repeat }) })
      const data: { ok?: boolean; code?: string; email?: string } = await res.json().catch(() => ({}))
      if (res.ok && data.ok !== false) { setDoneEmail(data.email ?? restoreEmail ?? ''); return }
      const code = data.code ?? 'failed'
      setError(code === 'short' ? c.short : code === 'mismatch' ? c.mismatch : code === 'email_unavailable' ? c.email_unavailable : code === 'rate_limited' ? c.rate_limited : ['invalid', 'used', 'expired', 'superseded'].includes(code) ? c.bad : c.failed)
    } catch {
      setError(c.failed)
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500'

  if (doneEmail !== null) {
    return (
      <div className="space-y-3" data-testid="undo-done">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-green-50 text-green-600"><CheckCircle className="h-6 w-6" aria-hidden="true" /></span>
        <h1 className="text-lg font-semibold text-zinc-900">{c.successTitle}</h1>
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">{fill(c.success, doneEmail)}</p>
        <a href="/portal/login" className="inline-flex px-4 py-2 text-sm rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700">{c.login}</a>
      </div>
    )
  }

  if (!restoreEmail) {
    return <p role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900" data-testid="undo-bad-link">{c.bad}</p>
  }

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold text-zinc-900">{c.title}</h1>
      <p className="text-sm text-zinc-700">{fill(c.intro, restoreEmail)}</p>
      <div>
        <label htmlFor="undo-pw" className="block text-sm font-medium text-zinc-700 mb-1">{c.newPassword}</label>
        <input id="undo-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null) }} className={inputClass} data-testid="undo-password" />
        <p className="mt-1 text-xs text-zinc-500">{c.min}</p>
      </div>
      <div>
        <label htmlFor="undo-pw2" className="block text-sm font-medium text-zinc-700 mb-1">{c.repeat}</label>
        <input id="undo-pw2" type="password" autoComplete="new-password" value={repeat} onChange={(e) => { setRepeat(e.target.value); setError(null) }} className={inputClass} data-testid="undo-repeat" />
      </div>
      <MustReadBlock title={c.readTitle} ackLabel={c.iReadIt} checked={read} onCheckedChange={(v) => { setRead(v); setError(null) }} invalid={tried}>
        <p><strong>{c.readStrong}</strong> {fill(c.readBody, restoreEmail)}</p>
      </MustReadBlock>
      {error && <p role="alert" className="text-sm font-semibold text-red-700" data-testid="undo-error">{error}</p>}
      <div className="flex items-center justify-end gap-3 flex-wrap">
        {!read && tried && <span className="text-sm text-red-700">{c.tick}</span>}
        <button type="button" onClick={submit} disabled={busy} data-testid="undo-submit" className={cn('flex items-center gap-2 px-4 py-2 text-sm rounded-lg font-medium', read ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-zinc-200 text-zinc-500', busy && 'opacity-60')}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? c.working : c.button}
        </button>
      </div>
    </div>
  )
}
