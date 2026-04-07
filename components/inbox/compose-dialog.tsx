'use client'

import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Send, Loader2, Sparkles } from 'lucide-react'

interface ComposeDialogProps {
  open: boolean
  onClose: () => void
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
  const [aiInstruction, setAiInstruction] = useState('')
  const [showAi, setShowAi] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const queryClient = useQueryClient()

  useEffect(() => { setTo(prefillTo) }, [prefillTo])
  useEffect(() => { setSubject(prefillSubject) }, [prefillSubject])
  useEffect(() => { setBody(prefillBody) }, [prefillBody])

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
      setTo('')
      setCc('')
      setSubject('')
      setBody('')
      setAiInstruction('')
      setShowAi(false)
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      onClose()
    },
  })

  const handleAiCompose = async () => {
    if (aiLoading || !aiInstruction.trim()) return
    setAiLoading(true)
    try {
      const res = await fetch('/api/inbox/ai-compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: aiInstruction,
          to: to || undefined,
          subject: subject || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'AI compose failed')
      }
      const data = await res.json()
      if (data.draft) {
        setBody(data.draft)
        setShowAi(false)
        setAiInstruction('')
      }
    } catch {
      // Silently fail
    } finally {
      setAiLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold text-zinc-900">New Email</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAi(!showAi)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                showAi
                  ? 'bg-violet-100 text-violet-700'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-violet-50 hover:text-violet-600'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              AI Draft
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-zinc-100 text-zinc-500"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* AI Instruction Panel */}
        {showAi && (
          <div className="px-5 py-3 bg-violet-50 border-b">
            <p className="text-xs text-violet-600 mb-2">
              Describe what you want to say and AI will draft the email:
            </p>
            <div className="flex items-end gap-2">
              <textarea
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder='e.g., "Tell them their LLC is ready and they need to sign the OA"'
                rows={2}
                className="flex-1 text-sm rounded-lg border border-violet-200 px-3 py-2 outline-none
                  focus:ring-2 focus:ring-violet-400 focus:border-transparent
                  placeholder:text-violet-400 resize-none bg-white"
              />
              <button
                onClick={handleAiCompose}
                disabled={aiLoading || !aiInstruction.trim()}
                className="shrink-0 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium
                  hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {aiLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Generate'
                )}
              </button>
            </div>
          </div>
        )}

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
