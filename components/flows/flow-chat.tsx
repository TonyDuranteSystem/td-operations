'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Languages, Loader2, Send, Wand2, X } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeTopic, resolveTypedTopic, topicChoices } from '@/lib/portal/document-share-text'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { requestPolish } from '@/lib/flows/polish-draft'

interface FlowChatProps {
  /** Either this (the normal case, backs /api/flows/[id]/chat) or apiPath
   *  must be given. */
  serviceDeliveryId?: string
  /** Override the endpoint entirely — used by the Onboarding Workspace's
   *  pre-review stage, which has no service_delivery yet to key on and
   *  instead posts to a contact-scoped sibling route
   *  (app/api/onboarding-review/[id]/chat/route.ts). Same GET/POST shape. */
  apiPath?: string
  label?: string
}

interface ChatMessage {
  id: string
  created_at: string | null
  sender_type: string
  sender_name: string | null
  message: string
  topic: string | null
  /** This message belongs to THIS return's thread. False = the client's other
   *  conversation with us — shown here so nothing they said is invisible to
   *  the person answering (card c5ff8b4d Phase 1). */
  in_flow?: boolean
}

/**
 * Flow Workspace chat panel — a per-service-delivery message stream backed by
 * portal_messages (filtered by service_delivery_id). Staff send messages to the
 * client about THIS flow; the POST auto-stamps service_delivery_id + topic (the
 * flow name) + account/contact, so the message appears in the client's portal
 * chat and notifies them. Client replies that reply to a flow message thread back
 * here. Messages render oldest-first (chronological).
 */
export function FlowChat({ serviceDeliveryId, apiPath, label }: FlowChatProps) {
  const endpoint = apiPath || `/api/flows/${serviceDeliveryId}/chat`
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Which topic the next message goes under (Calendar "Message client", Luca 2026-10-23). Only shown when the route says what the
  // job's own topic is (the onboarding pre-review route has no topics, so it stays as it was).
  const [topicInfo, setTopicInfo] = useState<{ defaultTopic: string | null; topics: string[] } | null>(null)
  const [pickedTopic, setPickedTopic] = useState<string | null>(null) // null = the job's own topic
  const [newTopic, setNewTopic] = useState('')
  // AI Polish (Luca, td-bug 2026-10-28) — same behaviour as Portal Chats: matches the client's language unless "keep as written" is on,
  // and asks which language when the client has not written anything it can read.
  const [clientIds, setClientIds] = useState<{ accountId: string | null; contactId: string | null }>({ accountId: null, contactId: null })
  const [polishing, setPolishing] = useState(false)
  const [preserveLanguage, setPreserveLanguage] = useState(false)
  const [polishAskLanguage, setPolishAskLanguage] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Could not load messages.')
      }
      setMessages(data.messages ?? [])
      setClientIds({ accountId: (data.account_id as string | null | undefined) ?? null, contactId: (data.contact_id as string | null | undefined) ?? null })
      if (data.default_topic !== undefined) {
        setTopicInfo({ defaultTopic: (data.default_topic as string | null) ?? null, topics: Array.isArray(data.topics) ? (data.topics as string[]) : [] })
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load messages.')
    } finally {
      setLoading(false)
    }
  }, [endpoint])

  useEffect(() => {
    load()
  }, [load])

  // Keep the latest message in view as the thread grows.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  // The topic to send under, or null = let the server use the job's own topic. A typed name wins over a picked chip.
  const typedTopic = normalizeTopic(newTopic)
  const chosenTopic = topicInfo
    ? (typedTopic ? resolveTypedTopic(typedTopic, [topicInfo.defaultTopic ?? '', ...topicInfo.topics].filter(Boolean)) : pickedTopic)
    : null
  const effectiveTopic = topicInfo ? (chosenTopic ?? topicInfo.defaultTopic) : null

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, ...(chosenTopic ? { topic: chosenTopic } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Could not send the message.')
      }
      setMessages((prev) => [...prev, data.message])
      setDraft('')
      // back to the job's own topic for the next message, and a topic just created is now one of the chat's open topics
      setPickedTopic(null)
      setNewTopic('')
      const sentTopic = (data.message?.topic as string | null | undefined) ?? null
      if (sentTopic) setTopicInfo((t) => (t && !t.topics.some((x) => x.trim().toLowerCase() === sentTopic.trim().toLowerCase()) ? { ...t, topics: [sentTopic, ...t.topics] } : t))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the message.')
    } finally {
      setSending(false)
    }
  }

  async function polish(targetLanguage?: string) {
    const text = draft
    if (!text.trim() || polishing) return
    setPolishing(true)
    try {
      const result = await requestPolish({ message: text, ...clientIds, preserveLanguage, targetLanguage })
      if (result.kind === 'ask') {
        setPolishAskLanguage(true)
        return
      }
      setPolishAskLanguage(false)
      // Staff kept typing while it was working — never overwrite what they wrote since.
      setDraft((current) => (current === text ? result.text : current))
      toast.success(result.appliedLanguage ? `Polished — translated to ${result.appliedLanguage}` : 'Polished — language kept as written')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'AI polish failed — please try again.')
    } finally {
      setPolishing(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-zinc-900 mb-3">{label || 'Chat'}</h3>

      <div
        ref={scrollRef}
        className="max-h-80 overflow-y-auto space-y-3 mb-3"
      >
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-zinc-500">No messages yet with this client.</p>
        ) : (
          messages.map((m) => {
            const isAdmin = m.sender_type === 'admin'
            // Messages outside this return's thread are the client's OTHER
            // conversation with us. They are shown (never hidden — that was the
            // defect) but visually quieter, and labelled so staff know the
            // context they were written in.
            const other = m.in_flow === false
            return (
              <div key={m.id} className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 ${
                    isAdmin
                      ? other ? 'bg-blue-400 text-white' : 'bg-blue-600 text-white'
                      : other ? 'border border-dashed border-zinc-300 bg-white text-zinc-700' : 'bg-zinc-100 text-zinc-900'
                  }`}
                >
                  <div className={`text-[11px] mb-0.5 ${isAdmin ? 'text-blue-100' : 'text-zinc-500'}`}>
                    {m.sender_name || (isAdmin ? 'Tony Durante Team' : 'Client')}
                    {other && <span className="ml-1 font-medium opacity-90">· other conversation</span>}
                    {m.topic && <span className="ml-1 opacity-80">· {m.topic}</span>}
                    {m.created_at && (
                      <span className="ml-1 opacity-80">
                        {new Date(m.created_at).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <div className="text-sm whitespace-pre-wrap break-words">{m.message}</div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <div className="space-y-2">
        {topicInfo && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
            <p className="text-xs text-zinc-600">
              This message goes to: <strong className="text-zinc-900">{effectiveTopic ?? 'the general chat (no topic)'}</strong>
              {!chosenTopic && topicInfo.defaultTopic ? " — this job's topic" : ''}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {topicChoices(topicInfo.defaultTopic ?? '', topicInfo.topics).map((t) => {
                const selected = !typedTopic && (pickedTopic ?? topicInfo.defaultTopic) === t
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setPickedTopic(t === topicInfo.defaultTopic ? null : t); setNewTopic('') }}
                    className={`max-w-[200px] truncate rounded-full border px-2.5 py-1 text-xs ${selected ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-white'}`}
                  >
                    {t}
                  </button>
                )
              })}
              <input
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                maxLength={100}
                placeholder="…or type a new topic"
                aria-label="New topic"
                className="min-w-[10rem] flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs"
              />
            </div>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Write a message…"
            rows={2}
            maxLength={5000}
            className="flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          {draft.trim() && (clientIds.accountId || clientIds.contactId) && (polishAskLanguage ? (
            <div className="flex items-center gap-1 pb-1">
              <span className="text-xs text-zinc-500 pr-1">Which language?</span>
              {['English', 'Italian'].map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => polish(lang)}
                  disabled={polishing}
                  className="rounded-full bg-violet-100 px-2 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200 disabled:opacity-50"
                >
                  {lang}
                </button>
              ))}
              <button type="button" onClick={() => setPolishAskLanguage(false)} aria-label="Cancel" className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 pb-1">
              <FastTooltip label={preserveLanguage ? 'Polish will keep the language as written — click to match the client instead' : "Polish will match the language the client is writing — click to keep it as written instead"}>
                <button
                  type="button"
                  onClick={() => setPreserveLanguage((v) => !v)}
                  aria-label={preserveLanguage ? 'Polish will keep the language as written — click to match the client instead' : "Polish will match the language the client is writing — click to keep it as written instead"}
                  className={`rounded-full p-2 ${preserveLanguage ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
                >
                  <Languages className="h-5 w-5" />
                </button>
              </FastTooltip>
              <FastTooltip label={preserveLanguage ? 'AI Polish — clean up grammar, keep language as written' : "AI Polish — clean up grammar and match the client's language"}>
                <button
                  type="button"
                  onClick={() => polish()}
                  disabled={polishing}
                  aria-label="AI Polish"
                  className="rounded-full bg-violet-100 p-2 text-violet-600 hover:bg-violet-200 disabled:opacity-50"
                >
                  {polishing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}
                </button>
              </FastTooltip>
            </div>
          ))}
          <button
            type="button"
            onClick={send}
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
