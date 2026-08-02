'use client'

import { useEffect, useState, useCallback } from 'react'
import { Mail, Loader2, CheckCircle2 } from 'lucide-react'

interface MailboxProgress {
  mailbox: 'support' | 'antonio'
  total: number
  complete: number
  remaining: number
  done: boolean
}

const LABEL: Record<string, string> = {
  support: 'Support inbox',
  antonio: 'Your inbox',
}

export function EmailBackupPanel() {
  const [enabled, setEnabled] = useState(false)
  const [mailboxes, setMailboxes] = useState<MailboxProgress[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox/email-backup')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Could not load'); return }
      setEnabled(data.enabled === true)
      setMailboxes(Array.isArray(data.mailboxes) ? data.mailboxes : [])
      setError(null)
    } catch {
      setError('Could not load')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // While it's running and not finished, refresh progress every 20s.
  useEffect(() => {
    const allDone = mailboxes.length > 0 && mailboxes.every((m) => m.done)
    if (!enabled || allDone) return
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [enabled, mailboxes, load])

  const toggle = async () => {
    const next = !enabled
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/inbox/email-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Save failed'); return }
      setEnabled(next)
      load()
    } catch {
      setError('Save failed')
    } finally {
      setSaving(false)
    }
  }

  const allDone = mailboxes.length > 0 && mailboxes.every((m) => m.done)

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-medium">Email backup</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Keeps a full copy of every email (and its attachments) in our own system, so the
        inbox is fast and works even if Gmail is slow or down. Turn it on once — it runs by
        itself, overnight, until everything is copied. Nothing else to do.
      </p>

      {loaded && mailboxes.map((m) => {
        const pct = m.total > 0 ? Math.round((m.complete / m.total) * 100) : (m.done ? 100 : 0)
        return (
          <div key={m.mailbox} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{LABEL[m.mailbox] ?? m.mailbox}</span>
              <span className="text-muted-foreground flex items-center gap-1">
                {m.done
                  ? <><CheckCircle2 className="h-4 w-4 text-green-600" /> Done</>
                  : `${m.complete.toLocaleString()} of ${m.total.toLocaleString()}`}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div className={`h-full ${m.done ? 'bg-green-600' : 'bg-blue-600'}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}

      <div className="flex items-center justify-between pt-1">
        <span className="text-sm">
          {allDone
            ? 'All email backed up. New mail is kept up to date automatically.'
            : enabled
              ? 'Backing up… runs overnight, comes back on its own.'
              : 'Off.'}
        </span>
        <button
          onClick={toggle}
          disabled={saving}
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 ${enabled ? 'bg-gray-500 hover:bg-gray-600' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
