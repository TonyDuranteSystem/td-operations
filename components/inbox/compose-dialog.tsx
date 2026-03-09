'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Send, Loader2 } from 'lucide-react'

interface ComposeDialogProps {
  open: boolean
  onClose: () => void
  // Pre-fill for forwarding
  prefillTo?: string
  prefillSubject?: string
  prefillBody?: string
}

export function ComposeDialog({
  open,
  onClose,
  prefillTo = '',
  prefillSubject = '',
  prefillBody = '',
}: ComposeDialogProps) {
  const [to, setTo] = useState(prefillTo)
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(prefillSubject)
  const [body, setBody] = useState(prefillBody)
  const [showCc, setShowCc] = useState(false)
  const queryClient = useQueryClient()

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/inbox/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          subject,
          message: body,
          ...(cc && { cc }),
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      // Reset form
      setTo('')
      setCc('')
      setSubject('')
      setBody('')
      // Refresh conversations to show sent message
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      onClose()
    },
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold text-zinc-900">New Email</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 text-zinc-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto">
          {/* To */}
          <div className="flex items-center border-b px-5 py-2">
            <label className="text-sm text-zinc-400 w-10 shrink-0">To</label>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="flex-1 text-sm outline-none bg-transparent"
              required
            />
            {!showCc && (
              <button
                onClick={() => setShowCc(true)}
                className="text-xs text-zinc-400 hover:text-zinc-600 shrink-0"
              >
                Cc
              </button>
            )}
          </div>

          {/* Cc */}
          {showCc && (
            <div className="flex items-center border-b px-5 py-2">
              <label className="text-sm text-zinc-400 w-10 shrink-0">Cc</label>
              <input
                type="email"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="cc@example.com"
                className="flex-1 text-sm outline-none bg-transparent"
              />
            </div>
          )}

          {/* Subject */}
          <div className="flex items-center border-b px-5 py-2">
            <label className="text-sm text-zinc-400 w-10 shrink-0">Sub</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 text-sm outline-none bg-transparent"
              required
            />
          </div>

          {/* Body */}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your email..."
            className="w-full min-h-[200px] px-5 py-3 text-sm outline-none bg-transparent resize-none"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t">
          {sendMutation.isError && (
            <p className="text-xs text-red-500">
              {sendMutation.error.message}
            </p>
          )}
          <div className="ml-auto">
            <button
              onClick={() => sendMutation.mutate()}
              disabled={!to.trim() || !subject.trim() || !body.trim() || sendMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium
                hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {sendMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
