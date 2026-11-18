'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { MustReadBlock } from '@/components/portal/must-read-block'
import type { StaffLoginLookupView } from '@/lib/portal/login-email-change-staff-shared'

/**
 * STAFF changes a client's portal LOGIN email (dev job beb43385, step 3). Opened from the contact's Portal tab, and from the
 * Email box on the contact page / company page when that contact has a login.
 *
 * It asks the server first for the REAL login email (found by the contact id), shows the big red "Read well before
 * proceeding." block with the "I read it" tick, then changes it right away: no code, the login and the contact move together,
 * and BOTH addresses are told. Refusals come back in plain English (staff are told who owns an email; the client never is).
 */
interface Props {
  contactId: string
  /** Pre-fills the new email (what staff typed in the inline Email box). */
  initialEmail?: string
  onClose: () => void
  /** Called after the change, when staff close the "done" screen. */
  onChanged: (newEmail: string) => void
}

type Done = { oldEmail: string; newEmail: string; noticeToNew: string; noticeToOld: string }

const noticeText = (to: string, state: string) =>
  state === 'sent' ? `A note was sent to ${to}.`
    : state === 'sandbox_blocked' ? `No note was sent to ${to} (test environment).`
      : `The note to ${to} could NOT be sent. Tell the client yourself.`

export function ChangeLoginEmailStaffDialog({ contactId, initialEmail, onClose, onChanged }: Props) {
  const [view, setView] = useState<StaffLoginLookupView | null>(null)
  const [newEmail, setNewEmail] = useState(initialEmail ?? '')
  const [read, setRead] = useState(false)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/crm/admin-actions/contact-login-email?contact_id=${encodeURIComponent(contactId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!alive) return
        if (!res.ok) setView({ state: 'none', message: data.error ?? 'Could not read the login right now. Try again in a moment.' })
        else setView(data as StaffLoginLookupView)
      })
      .catch(() => alive && setView({ state: 'none', message: 'Could not read the login right now. Try again in a moment.' }))
    return () => { alive = false }
  }, [contactId])

  const submit = async () => {
    if (!read) { setTried(true); return }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-login-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, new_email: newEmail }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'The change did not go through. Try again.')
      setDone({ oldEmail: data.old_email, newEmail: data.new_email, noticeToNew: data.notice_to_new, noticeToOld: data.notice_to_old })
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The change did not go through. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const linked = view && view.state === 'linked' ? view : null
  const name = linked?.contactName ?? 'the client'

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={done ? () => onChanged(done.newEmail) : onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Change login email"
          data-testid="staff-change-login-email"
          className="pointer-events-auto bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <h2 className="text-lg font-semibold">Change login email</h2>
            <button onClick={done ? () => onChanged(done.newEmail) : onClose} className="p-1 rounded hover:bg-zinc-100" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            {!view && (
              <div className="flex items-center justify-center py-8 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400 mr-2" /> Reading the login…
              </div>
            )}

            {view && !linked && (
              <p data-testid="staff-login-email-refusal" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {'message' in view ? view.message : 'No login found.'}
              </p>
            )}

            {linked && !done && (
              <>
                <div className="rounded-lg bg-zinc-50 border p-3 text-sm space-y-1">
                  <div><span className="text-zinc-500">Signs in with:</span> <strong data-testid="staff-current-login-email">{linked.loginEmail}</strong></div>
                  {linked.contactEmail && linked.contactEmail.trim().toLowerCase() !== linked.loginEmail.trim().toLowerCase() && (
                    <div className="text-amber-700">The contact record has a different email ({linked.contactEmail}). It will be set to the new one too.</div>
                  )}
                  {linked.suspended && <div className="text-red-700">This login is suspended. It stays suspended.</div>}
                </div>

                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">New login email</span>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => { setNewEmail(e.target.value); setError(null) }}
                    placeholder="name@example.com"
                    autoComplete="off"
                    data-testid="staff-new-login-email"
                    className="w-full px-3 py-2 rounded-lg border text-sm"
                  />
                </label>

                <MustReadBlock
                  title="Read well before proceeding."
                  ackLabel="I read it"
                  checked={read}
                  onCheckedChange={(v) => { setRead(v); setError(null) }}
                  invalid={tried}
                >
                  <p>
                    This changes the email {name} signs in with, <strong>right now, with no code.</strong> Be sure the client asked for it and that the new address is theirs.
                  </p>
                  <p>Both addresses get a note. The password stays the same.</p>
                  <p>
                    Anyone already signed in <strong>stays signed in.</strong> If the old login may have been stolen, also press &ldquo;Send new password&rdquo; afterwards.
                  </p>
                </MustReadBlock>

                {error && (
                  <p role="alert" data-testid="staff-login-email-error" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
                )}
              </>
            )}

            {done && (
              <div data-testid="staff-login-email-done" className="space-y-2 text-sm">
                <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
                  Done. {name === 'the client' ? 'The client' : name} now signs in with <strong>{done.newEmail}</strong>. The contact email changed with it.
                </p>
                <p>{noticeText(done.newEmail, done.noticeToNew)}</p>
                <p>{noticeText(done.oldEmail, done.noticeToOld)}</p>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t shrink-0">
            {done ? (
              <button onClick={() => onChanged(done.newEmail)} className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800">Close</button>
            ) : (
              <>
                <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-zinc-50">Cancel</button>
                {linked && (
                  <button
                    onClick={submit}
                    disabled={busy || !newEmail.trim()}
                    aria-disabled={!read}
                    data-testid="staff-login-email-submit"
                    className={
                      read
                        ? 'px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50'
                        : 'px-4 py-2 rounded-lg bg-zinc-200 text-zinc-500 text-sm font-semibold'
                    }
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Change login email'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
