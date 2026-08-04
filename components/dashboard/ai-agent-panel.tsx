'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { Bot, X, Send, Loader2, Mic, Square, Sparkles, Paperclip, FileText, History, SquarePen, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHoldToSend } from '@/components/chat/use-hold-to-send'
import { useWorkerAttachments, type UploadedAttachment } from '@/components/chat/use-worker-attachments'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { clientKeyFromPath } from '@/lib/ai-agent/sidebar-scope'
import { WorkerSettingsGear } from '@/components/chat/worker-settings-gear'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import { ConfirmAttachments } from '@/components/inbox/confirm-attachments'

interface Message {
  role: 'user' | 'assistant'
  content: string
  /**
   * Files the assistant produced this turn, sent by the server as structured data.
   *
   * Rendered as a real button rather than relying on the reply to include the link:
   * on its first live run the assistant built the PDF correctly and then wrote
   * "Here's the PDF" with the link missing — the same thing Luca reported on 10 July,
   * reproduced by the feature meant to fix it.
   */
  artifacts?: { kind: string; url: string; label: string }[]
  /** Id of the stored turn this came from — present only for restored/sent turns.
   *  Without it a message cannot be edited or deleted, because there is no row to
   *  rewind to. */
  turnId?: string
}

/** Which conversation this browser was last in. Survives a refresh; the server
 *  still scopes every read to the logged-in user, so a stale or foreign id simply
 *  returns nothing rather than exposing someone else's history. */
const CONVERSATION_KEY = 'td-ai-agent-conversation'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AiAgentPanel({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  /**
   * Attachments, on the SAME machinery as the Inbox and Portal-Chats panels.
   *
   * This panel used to hold ONE file and base64 it into the request body, with a
   * six-MIME-type picker — which is why Luca could not attach a spreadsheet and why
   * a second file replaced the first. The shared hook uploads straight to the
   * private bucket through a signed URL (bytes never ride in the body, so a large
   * scan no longer 413s), keeps up to five files, and applies the one type policy
   * every other chat upload uses.
   */
  const att = useWorkerAttachments()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Stable id for THIS conversation (worker-path memory thread). Minted lazily on
  // first send; a new chat mints a fresh one → fresh worker memory.
  const conversationIdRef = useRef<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Array<{ id: string; title: string; lastAt: string; turns: number }>>([])
  const [restoring, setRestoring] = useState(false)
  /** A draft frozen server-side, waiting for this staff member to confirm it.
   *  Confirm sends EXACTLY these bytes — it does not re-ask the assistant. */
  const [preparedSend, setPreparedSend] = useState<{
    id: string
    to: string
    subject: string
    body: string
    attachments?: Array<{ name: string; size?: number; content_type?: string; origin?: string; warning?: string }>
  } | null>(null)
  const [confirming, setConfirming] = useState(false)
  // WHICH OF OUR ADDRESSES IT GOES OUT FROM — chosen here, re-checked by the server.
  const [sendAs, setSendAs] = useState<'support' | 'antonio'>('support')
  // Live route → per-page client scope for the worker's brain. Read at SEND time
  // (below), never cached, so navigating between clients can't mis-scope.
  const pathname = usePathname()


  /** One place that writes the conversation id — ref (read at send time), state
   *  (rendering) and localStorage (survives the refresh) can never disagree. */
  const setConversationId = useCallback((id: string | null) => {
    conversationIdRef.current = id
    try {
      if (id) window.localStorage.setItem(CONVERSATION_KEY, id)
      else window.localStorage.removeItem(CONVERSATION_KEY)
    } catch {
      // Private mode / storage disabled — the conversation still works for this
      // session, it just won't survive a refresh. Not worth failing the panel over.
    }
  }, [])

  /** Rebuild the on-screen thread from stored turns. Returns false when there is
   *  nothing to restore, so the caller can fall back to a blank chat. */
  const loadConversation = useCallback(async (id: string): Promise<boolean> => {
    setRestoring(true)
    try {
      const res = await fetch(`/api/ai-agent?conversationId=${encodeURIComponent(id)}`)
      if (!res.ok) return false
      const data = await res.json().catch(() => ({}))
      const turns: Array<{ id: string; user: string; assistant: string }> = Array.isArray(data.turns) ? data.turns : []
      if (!turns.length) return false
      const restored: Message[] = []
      for (const t of turns) {
        if (t.user) restored.push({ role: 'user', content: t.user, turnId: t.id })
        // A turn with no reply is one that never finished — show the question so the
        // history isn't silently missing it, but don't invent an answer.
        if (t.assistant) restored.push({ role: 'assistant', content: t.assistant, turnId: t.id })
      }
      setMessages(restored)
      setConversationId(id)
      return true
    } catch {
      return false
    } finally {
      setRestoring(false)
    }
  }, [setConversationId])

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-agent?list=1')
      if (!res.ok) return
      const data = await res.json().catch(() => ({}))
      if (Array.isArray(data.conversations)) setHistory(data.conversations)
    } catch {
      // A failed history fetch must never break the chat itself.
    }
  }, [])

  // Restore on open. Only when the panel is empty — reopening mid-conversation must
  // not wipe what is on screen.
  useEffect(() => {
    if (!open || messages.length > 0) return
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(CONVERSATION_KEY)
    } catch {
      stored = null
    }
    if (stored) void loadConversation(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** Delete a turn and everything after it. The rewind behind both Edit and Delete. */
  const truncateFrom = useCallback(async (turnId: string): Promise<boolean> => {
    const id = conversationIdRef.current
    if (!id) return false
    try {
      const res = await fetch(
        `/api/ai-agent?conversationId=${encodeURIComponent(id)}&fromTurnId=${encodeURIComponent(turnId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.error || 'Could not update that conversation.')
        return false
      }
      return true
    } catch {
      toast.error('Could not update that conversation.')
      return false
    }
  }, [])

  /** Edit = rewind to this message and put it back in the box. Re-sending goes
   *  through the ordinary send path, so the assistant's own memory (which it
   *  rebuilds from the same stored thread) matches what you see. */
  const editMessage = useCallback(async (index: number) => {
    const msg = messages[index]
    if (!msg?.turnId || loading) return
    if (!(await truncateFrom(msg.turnId))) return
    setMessages(messages.slice(0, index))
    setInput(msg.content)
    inputRef.current?.focus()
  }, [messages, loading, truncateFrom])

  const deleteFromMessage = useCallback(async (index: number) => {
    const msg = messages[index]
    if (!msg?.turnId || loading) return
    if (!window.confirm('Delete this message and everything after it?')) return
    if (!(await truncateFrom(msg.turnId))) return
    setMessages(messages.slice(0, index))
  }, [messages, loading, truncateFrom])

  // Voice input
  const handleTranscript = useCallback((text: string) => {
    setInput(prev => (prev ? prev + ' ' + text : text).trim())
    inputRef.current?.focus()
  }, [])

  const {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    isSupported: micSupported,
  } = useVoiceInput({ language: 'en-US', onTranscript: handleTranscript })

  // Drag & drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    // EVERY dropped file, not just the first — dropping three and silently reading
    // one is the same failure as the second upload replacing the first.
    const dropped = Array.from(e.dataTransfer.files)
    if (dropped.length) void att.add(dropped)
  }, [att])

  // Listen for open event from sidebar (with optional email context)
  useEffect(() => {
    function handleOpen(e: Event) {
      setOpen(true)
      const detail = (e as CustomEvent)?.detail
      if (detail?.emailContext) {
        const ctx = detail.emailContext
        const autoPrompt = `I'm looking at this email. Analyze it and suggest a reply + any CRM actions I should take.\n\n**From:** ${ctx.name}\n**Subject:** ${ctx.subject}\n**Preview:** ${ctx.preview}\n**Thread ID:** ${ctx.threadId}`
        setTimeout(() => {
          setInput('')
          const userMsg: Message = { role: 'user', content: autoPrompt }
          setMessages(prev => [...prev, userMsg])
          sendMessage([...messages, userMsg])
        }, 200)
      }
    }
    document.addEventListener('open-ai-agent', handleOpen)
    return () => document.removeEventListener('open-ai-agent', handleOpen)
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus input when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  /**
   * Auto-grow the composer.
   *
   * It used to open as a SINGLE 44px line capped at 120px, so the placeholder
   * alone wrapped and the box showed a scrollbar before a word was typed — you
   * could not see what you were writing (Antonio, 2026-07-28: "it's small and
   * scrollable"). Now it opens at a readable three lines and grows with the text.
   *
   * The ceiling is a share of the WINDOW, not a fixed pixel count, because the
   * whole CRM is used as a phone app at ~380px where a tall box would swallow the
   * conversation. Scrolling turns on only once that ceiling is reached, so the
   * scrollbar means "there is more above", never "this box is too small".
   */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const min = 84 // ≈ 3 lines — enough to see a full sentence while typing
    // A viewport share, but never TRUSTED BLINDLY: window.innerHeight can be 0 in
    // a hidden/background tab and during some embedded runs (measured 0 in QA). A
    // bare Math.min against that collapses the ceiling onto the minimum and the
    // box can never grow — the very bug this effect exists to fix. So fall back to
    // a normal desktop height, and keep a floor well above `min`.
    const vh = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 800
    const max = Math.max(min + 60, Math.min(260, Math.round(vh * 0.35)))
    el.style.height = '0px'
    const next = Math.max(min, Math.min(el.scrollHeight, max))
    el.style.height = next + 'px'
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
    // `open` is a dependency because the panel returns null while closed: the
    // textarea is attached without this component remounting, so on re-open the
    // effect would not run and the height would depend on the `rows` attribute
    // happening to match `min`. Sizing it explicitly keeps the two from drifting.
  }, [input, open])

  /** Returns true when the turn completed; false when it failed (caller restores files). */
  const sendMessage = async (msgs: Message[], attachments?: UploadedAttachment[]): Promise<boolean> => {
    setLoading(true)
    try {
      const res = await fetch('/api/ai-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs.map(m => ({ role: m.role, content: m.content })),
          // Storage paths only — the bytes went straight to the private bucket.
          attachments: attachments?.length ? attachments : undefined,
          // Worker path (when enabled): a stable per-conversation thread + the live
          // per-page client scope.
          conversationId: (() => {
            if (!conversationIdRef.current) setConversationId(crypto.randomUUID())
            return conversationIdRef.current
          })(),
          clientKey: clientKeyFromPath(pathname),
        }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(errData.error || `Request failed (${res.status})`)
      }

      const data = await res.json()
      // The emergency fallback engine still reports itself, and it is READ-ONLY —
      // worth flagging so a degraded answer is not mistaken for a normal one.
      const engineNote = data.provider === 'openai' || data.provider === 'claude'
        ? ' _(fallback engine — lookups only, no sending)_'
        : ''
      const toolInfo = data.tools_used?.length ? `\n\n_🔧 Used: ${Array.from(new Set(data.tools_used) as Set<string>).join(', ')}_` : ''
      // Tag BOTH sides of the exchange with the stored turn id, so the message can
      // be edited or rewound immediately — not only after a reload.
      setPreparedSend(data.preparedSend ?? null)
      // Each card starts from the default sender. Carrying a previous card's
      // "antonio" pick into the next draft is how an email goes out from the
      // wrong address without anyone deciding it should.
      if (data.preparedSend) setSendAs('support')
      const turnId = typeof data.messageId === 'string' ? data.messageId : undefined
      setMessages(prev => {
        const next = [...prev]
        if (turnId) {
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === 'user') { next[i] = { ...next[i], turnId }; break }
          }
        }
        next.push({
          role: 'assistant',
          content: (data.content || 'No response.') + engineNote + toolInfo,
          artifacts: Array.isArray(data.artifacts) ? data.artifacts : undefined,
          turnId,
        })
        return next
      })
      return true
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${errMsg}` }])
      return false
    } finally {
      setLoading(false)
    }
  }

  // Runs only once the hold expires (or Enter is pressed a second time). Nothing is
  // cleared until here — cancelling has to leave the box exactly as it was.
  //
  // The turn is SNAPSHOT when send is pressed and carried through the hold, never
  // re-read when the timer fires. Re-reading loses both ways during those seconds:
  // a file dropped mid-countdown is still uploading at fire time, so it is excluded
  // AND then wiped by the clear — silently, because the failed-file confirm already
  // ran; and a file attached after the send decision would otherwise join a turn the
  // staff member never agreed to send. Same contract as the Inbox/Portal composer.
  const { armed, secondsLeft, arm, cancel } = useHoldToSend<{
    text: string
    files: UploadedAttachment[]
  }>(async ({ text, files: filesToSend }) => {
    if (!text && !filesToSend.length) return

    // Build display content (what shows in chat history)
    const displayContent = [
      text,
      filesToSend.length ? filesToSend.map((f) => `📎 ${f.name}`).join('\n') : '',
    ].filter(Boolean).join('\n\n')

    const userMessage: Message = { role: 'user', content: displayContent }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    att.clear()
    // Height is NOT reset here — clearing the text re-runs the auto-grow effect,
    // which returns the box to its minimum. Setting 'auto' as well produced a
    // one-frame collapse to a single line before the effect corrected it.
    const ok = await sendMessage(newMessages, filesToSend)
    // A failed turn must NOT eat the attachment. The composer clears optimistically
    // (right feel), but on failure the file is put back so "try again" actually
    // re-sends it — otherwise the history bubble still shows 📎 while the retry
    // carries nothing, and the assistant answers about a file it never received
    // (td-bug 2026-08-03, after a transient provider overload).
    if (!ok && filesToSend.length) att.restore(filesToSend)
  })

  /** Confirm or discard a frozen draft. The endpoint dispatches the stored bytes;
   *  the outcome comes from the HTTP result, never from the assistant's prose —
   *  a model that says "sent" is not evidence that anything was sent. */
  const resolvePreparedSend = useCallback(async (action: 'confirm' | 'cancel') => {
    if (!preparedSend) return
    setConfirming(true)
    try {
      const res = await fetch('/api/inbox/worker-chat/confirm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepared_id: preparedSend.id, action, mailbox: sendAs }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // R099 — say what the server said, never a generic failure.
        toast.error(data.error || 'Could not complete that — please try again.')
        return
      }
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: action === 'confirm' ? `✅ Sent to ${preparedSend.to}.` : 'Cancelled — nothing was sent.',
      }])
      setPreparedSend(null)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not complete that.')
    } finally {
      setConfirming(false)
    }
  }, [sendAs, preparedSend])

  const readyFiles = att.files.filter((f) => f.path && !f.error)
  const stillUploading = att.files.some((f) => !f.path && !f.error)

  const handleSend = () => {
    if ((!input.trim() && !readyFiles.length) || loading) return
    // Sending mid-upload would drop the file silently — the exact "the worker
    // ignored my attachment" outcome.
    if (att.uploading || stillUploading) {
      toast.error('Still uploading — one moment.')
      return
    }
    // Never let a failed file vanish on send: an answer built without the document
    // the staff member believes it read is worse than no answer.
    const lost = att.failed()
    if (lost.length) {
      const names = lost.map((f) => f.name).join(', ')
      if (!window.confirm(`${names} could not be uploaded and will NOT be sent.\n\nSend anyway?`)) return
    }
    if (isRecording) stopRecording()
    // A bare file gets an implicit ask, so the worker has something to act on
    // rather than replying "what would you like me to do with this?".
    const text = input.trim()
    const files = att.uploaded()
    const message = text || (files.length ? 'Look at the attached file(s).' : '')
    if (!message) return
    // While held, a second press means "I'm sure" — the hook fires immediately.
    arm({ text: message, files })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Escape while held = "I hit Enter too early".
    if (e.key === 'Escape' && armed) {
      e.preventDefault()
      cancel()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const clearChat = () => {
    setMessages([])
    att.clear()
    // Start a fresh worker-memory thread for the next conversation, and stop
    // restoring the old one on the next open.
    setConversationId(null)
  }

  if (!open) return null

  if (!enabled) {
    return (
      <>
        <div className="fixed inset-0 z-[55] bg-black/30 lg:hidden" onClick={() => setOpen(false)} />
        <div className="fixed right-0 top-0 bottom-0 z-[55] w-full sm:w-[420px] bg-white border-l shadow-2xl flex flex-col items-center justify-center p-8">
          <Bot className="h-12 w-12 text-zinc-300 mb-4" />
          <h3 className="text-lg font-semibold text-zinc-700 mb-2">AI Agent Not Enabled</h3>
          <p className="text-sm text-zinc-500 text-center">Ask your admin to enable the AI Agent for team members in Team Management settings.</p>
          <button onClick={() => setOpen(false)} className="mt-6 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm">Close</button>
        </div>
      </>
    )
  }

  return (
    <>
      {/* Backdrop on mobile */}
      <div
        className="fixed inset-0 z-[55] bg-black/30 lg:hidden"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 bottom-0 z-[55] w-full sm:w-[420px] bg-white border-l shadow-2xl flex flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag & drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-violet-400 bg-violet-50/90 pointer-events-none">
            <div className="text-center">
              <Paperclip className="h-10 w-10 text-violet-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-violet-600">Drop files here</p>
              {/* Must match what the upload route actually accepts. The old copy
                  named six formats and 10MB, which told a staff member holding a
                  spreadsheet that it was unsupported — the reported bug, in the UI. */}
              <p className="text-xs text-violet-400 mt-1">Up to 5 files — documents, spreadsheets, images — max 20MB each</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-violet-50 to-blue-50">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-violet-100">
              <Bot className="h-5 w-5 text-violet-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">AI Agent</h2>
              <p className="text-[10px] text-zinc-500">Search, analyze, create tasks</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Assistant model — the SAME shared setting as every other worker panel.
                This is the ONLY model control. The old Auto/Claude/GPT-4o provider
                selector that used to sit here is gone: the sidebar runs the worker,
                which ignored the choice entirely, so it was a control that looked like
                a decision and wasn't. Same class of thing as an assistant offering an
                action it cannot perform. */}
            <WorkerSettingsGear />
            {/* Past conversations. Opening the list fetches it — there is no reason to
                pay for that on every page load when the panel is usually closed. */}
            <button
              onClick={() => {
                const next = !historyOpen
                setHistoryOpen(next)
                if (next) void loadHistory()
              }}
              className={cn(
                'p-2 rounded-lg transition-colors',
                historyOpen ? 'bg-violet-100 text-violet-600' : 'text-zinc-400 hover:text-violet-600 hover:bg-violet-50',
              )}
              title="Past conversations"
            >
              <History className="h-4 w-4" />
            </button>
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="p-2 rounded-lg text-zinc-400 hover:text-violet-600 hover:bg-violet-50 transition-colors"
                title="New chat (this one is saved)"
              >
                <SquarePen className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="p-4 rounded-2xl bg-violet-50 mb-4">
                <Sparkles className="h-8 w-8 text-violet-500" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900 mb-1">CRM AI Agent</h3>
              <p className="text-sm text-zinc-500 mb-6">
                Ask me anything about your clients, services, payments, or tasks.
              </p>
              <div className="space-y-2 w-full max-w-xs">
                {[
                  'Show me all overdue payments',
                  'What services are in progress?',
                  'Find client Marco Rossi',
                  'Create a task to follow up with...',
                  'Dashboard overview',
                ].map(suggestion => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setInput(suggestion)
                      inputRef.current?.focus()
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-zinc-600 bg-zinc-50 rounded-lg hover:bg-violet-50 hover:text-violet-700 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                'flex items-end gap-1',
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              )}
            >
              {/* Edit / rewind, on your OWN messages only, and only once the turn has
                  been stored (a turn with no id has no row to rewind to). Always
                  visible rather than hover-only: the whole CRM is used as a phone app,
                  where there is no hover. */}
              {msg.role === 'user' && msg.turnId && !loading && (
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button
                    onClick={() => void editMessage(i)}
                    className="p-1 rounded text-zinc-300 hover:text-violet-600 hover:bg-violet-50 transition-colors"
                    title="Edit this message and continue from here"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => void deleteFromMessage(i)}
                    className="p-1 rounded text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Delete this message and everything after it"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-md'
                    : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
                )}
              >
                {msg.role === 'assistant' ? (
                  <div className="prose prose-sm prose-zinc max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_a]:text-blue-600 [&_a]:underline [&_code]:bg-zinc-200 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-zinc-800 [&_pre]:text-zinc-100 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_img]:rounded-lg [&_img]:max-w-full [&_img]:my-2 [&_img]:border [&_img]:shadow-sm">
                    <ReactMarkdown
                      components={{
                        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
                        img: (props) => <img {...props} loading="lazy" style={{ maxHeight: 400 }} />,
                      }}
                    >{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                )}
                {/* Produced files, rendered from server data — present whatever the
                    reply text happens to say about them. */}
                {msg.artifacts?.length ? (
                  <div className="flex flex-wrap gap-2 pt-2">
                    {msg.artifacts.map((a, ai) => (
                      <a
                        key={ai}
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        {a.label}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-zinc-100 rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                <span className="text-sm text-zinc-500">Thinking...</span>
              </div>
            </div>
          )}
        </div>

        {/* Recording indicator */}
        {(isRecording || isTranscribing) && (
          <div className="px-4 py-2 bg-red-50 border-t border-red-100 flex items-center gap-2">
            {isRecording && (
              <>
                <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
                <span className="text-xs text-red-600 font-medium">Recording... tap mic to stop</span>
              </>
            )}
            {isTranscribing && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                <span className="text-xs text-blue-600 font-medium">Transcribing...</span>
              </>
            )}
          </div>
        )}

        {historyOpen && (
          <div className="border-b bg-zinc-50 max-h-64 overflow-y-auto">
            {history.length === 0 ? (
              <p className="px-4 py-3 text-xs text-zinc-500">No earlier conversations yet.</p>
            ) : (
              history.map((h) => (
                <button
                  key={h.id || 'legacy'}
                  onClick={() => {
                    setHistoryOpen(false)
                    void loadConversation(h.id)
                  }}
                  className={cn(
                    'w-full text-left px-4 py-2.5 border-b border-zinc-100 hover:bg-violet-50 transition-colors',
                    h.id === conversationIdRef.current && 'bg-violet-50',
                  )}
                >
                  <p className="text-xs font-medium text-zinc-800 truncate">{h.title || 'Conversation'}</p>
                  <p className="text-[10px] text-zinc-400">
                    {new Date(h.lastAt).toLocaleString()} · {h.turns} {h.turns === 1 ? 'message' : 'messages'}
                  </p>
                </button>
              ))
            )}
          </div>
        )}

        {restoring && (
          <p className="px-4 py-2 text-[11px] text-zinc-500 border-b">Loading your conversation…</p>
        )}

        {/* A draft frozen for confirmation. The address is monospaced and never
            shortened, and the message itself is shown — confirming a recipient
            without reading the body is how someone approves one draft while a
            different one goes out. */}
        {preparedSend && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 shrink-0">
            <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide mb-1">Check the address, then confirm</p>
            <p className="text-sm text-zinc-800">
              Email <span className="font-mono font-medium break-all">{preparedSend.to}</span>
            </p>
            {preparedSend.subject ? (
              <p className="text-xs text-zinc-600 mt-0.5">Subject: {preparedSend.subject}</p>
            ) : null}
            {preparedSend.body ? (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-white px-2.5 py-2">
                <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{preparedSend.body}</p>
              </div>
            ) : null}
            <ConfirmAttachments
              preparedId={preparedSend.id}
              attachments={preparedSend.attachments ?? []}
              onChange={files => setPreparedSend(p => (p ? { ...p, attachments: files } : p))}
            />
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-zinc-500">From:</span>
              <select
                value={sendAs}
                onChange={e => setSendAs(e.target.value as 'support' | 'antonio')}
                disabled={confirming}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 disabled:opacity-50"
              >
                <option value="support">support@tonydurante.us</option>
                <option value="antonio">antonio.durante@tonydurante.us</option>
              </select>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                onClick={() => void resolvePreparedSend('confirm')}
                disabled={confirming}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {confirming ? 'Sending…' : 'Confirm & send'}
              </button>
              <button
                onClick={() => void resolvePreparedSend('cancel')}
                disabled={confirming}
                className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Attached files — one row each, with its own upload state. A file that
            failed says so here instead of disappearing. */}
        {att.files.length > 0 && (
          <div className="px-3 py-2 border-t bg-violet-50 flex flex-col gap-1.5">
            {att.files.map((f) => (
              <div key={f.localId} className="flex items-center gap-2">
                <div
                  className={cn(
                    'h-8 w-8 rounded border flex items-center justify-center shrink-0',
                    f.error ? 'bg-red-100 border-red-200' : 'bg-violet-100 border-violet-200',
                  )}
                >
                  {f.error ? (
                    <X className="h-4 w-4 text-red-500" />
                  ) : f.path ? (
                    <FileText className="h-4 w-4 text-violet-500" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-zinc-800 truncate">{f.name}</p>
                  <p className={cn('text-[10px]', f.error ? 'text-red-600' : 'text-zinc-400')}>
                    {f.error ? f.error : f.path ? formatFileSize(f.size) : 'Uploading…'}
                  </p>
                </div>
                <button
                  onClick={() => att.remove(f.localId)}
                  className="p-1 rounded-full text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                  title="Remove attachment"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {att.limitNotice && <p className="text-[11px] text-amber-700">{att.limitNotice}</p>}
          </div>
        )}

        {/* Input */}
        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={att.onPaste}
              rows={3}
              placeholder={isRecording ? 'Recording...' : 'Ask anything about your CRM...'}
              // overflow is set by the auto-grow effect (hidden until the ceiling),
              // so it is deliberately NOT in this class list.
              className={cn(
                'flex-1 min-w-0 px-4 py-3 text-sm leading-relaxed border rounded-xl bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:bg-white resize-none transition-colors',
                isRecording && 'ring-2 ring-red-300 bg-red-50/50'
              )}
            />
            {/* Hidden file input. NO accept filter: the one type policy lives in the
                upload route (executables blocked, everything the reader understands
                allowed). A narrower list here is what made spreadsheets unpickable. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={e => {
                const picked = Array.from(e.target.files ?? [])
                if (picked.length) void att.add(picked)
                e.target.value = ''
              }}
              className="hidden"
            />
            {/* Attach */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className={cn(
                'p-3 rounded-xl transition-colors shrink-0',
                att.files.length
                  ? 'bg-violet-100 text-violet-600'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-violet-100 hover:text-violet-600'
              )}
              title="Attach files (up to 5 — documents, spreadsheets, images)"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            {/* Mic */}
            {micSupported && (
              isRecording ? (
                <button
                  onClick={stopRecording}
                  className="p-3 rounded-xl bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse transition-all shrink-0"
                >
                  <Square className="h-5 w-5 fill-current" />
                </button>
              ) : isTranscribing ? (
                <button disabled className="p-3 rounded-xl bg-blue-100 text-blue-500 shrink-0">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </button>
              ) : (
                <button
                  onClick={startRecording}
                  className="p-3 rounded-xl bg-zinc-100 text-zinc-600 hover:bg-violet-100 hover:text-violet-600 transition-colors shrink-0"
                  title="Voice input"
                >
                  <Mic className="h-5 w-5" />
                </button>
              )
            )}
            {/* Send — amber while the message is held, so the state is visible at a
                glance and the same button doubles as "send it now". */}
            <button
              onClick={handleSend}
              disabled={(!input.trim() && !readyFiles.length) || loading}
              className={cn(
                'p-3 rounded-xl text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0',
                armed ? 'bg-amber-500 hover:bg-amber-600' : 'bg-violet-600 hover:bg-violet-700',
              )}
              title={armed ? 'Send now' : 'Send'}
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
          {armed && (
            <div className="flex items-center gap-2 px-1 pt-1.5">
              <span className="text-[11px] text-amber-700">Sending in {secondsLeft}s…</span>
              <button
                onClick={cancel}
                className="text-[11px] font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
              >
                Stop
              </button>
              <span className="text-[10px] text-zinc-400">or press Esc — your text stays put</span>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
