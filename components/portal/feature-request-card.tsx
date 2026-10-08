'use client'

import { useState } from 'react'
import { Lightbulb, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

/**
 * "Do you want a new feature? Write us." (Antonio 2026-10-08). The idea goes to the Tony Durante team as a normal
 * message in the client's own portal chat (the place staff already watch and answer), clearly prefixed so it is easy
 * to spot. Nothing new for staff to monitor; the client can see what they sent and any reply in their chat.
 */
export function FeatureRequestCard({
  accountId,
  labels,
}: {
  accountId: string
  labels: { title: string; body: string; placeholder: string; send: string; sent: string; prefix: string; tooShort: string }
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const idea = text.trim()
    if (idea.length < 5) { toast.error(labels.tooShort); return }
    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          sender_context: 'company',
          message: `${labels.prefix}\n${idea}`,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send your idea. Please try again.')
      }
      setText('')
      setDone(true)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not send your idea. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm space-y-3" data-tour="feature-request" data-testid="feature-request">
      <div className="flex items-start gap-3">
        <Lightbulb className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">{labels.title}</h2>
          <p className="text-sm text-zinc-600">{labels.body}</p>
        </div>
      </div>
      {done ? (
        <p className="text-sm text-emerald-700" data-testid="feature-request-sent">{labels.sent}</p>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <textarea
            id="feature-request-text"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={labels.placeholder}
            rows={3}
            maxLength={1500}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={sending}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {labels.send}
          </button>
        </form>
      )}
    </div>
  )
}
