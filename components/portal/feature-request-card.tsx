'use client'

import { useState } from 'react'
import { Lightbulb, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

/**
 * "Do you have an idea? Share it with us." (Antonio 2026-10-08). The idea is saved for the Tony Durante team and shows
 * up in Portal Chats, in the client's "Idea request" tab (blue dot while nobody has handled it). It does NOT go into
 * the client's chat.
 */
export function FeatureRequestCard({
  accountId,
  labels,
}: {
  accountId: string
  labels: { title: string; body: string; placeholder: string; send: string; sent: string; tooShort: string }
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
      const res = await fetch('/api/portal/feature-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, idea }),
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
