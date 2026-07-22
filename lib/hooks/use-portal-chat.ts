'use client'

import { useEffect, useState, useCallback } from 'react'
import type { PortalMessage, ChatAttachment } from '@/lib/types'
import { buildChatQueryPlan, messageVisibleInPlan, type ChatQueryPlan } from '@/lib/portal/chat-scope'
import { useRealtimeChannel } from '@/lib/hooks/use-realtime-channel'

/**
 * The thread a client is currently viewing. Per-company scoping (2026-06-24):
 *  - 'company'  → one company's shared thread. includePersonalNull is decided
 *                 SERVER-SIDE (sole-owned account) and passed here only for the
 *                 realtime drop-filter; the GET route re-derives it authoritatively.
 *  - 'personal' → the contact's own untagged thread (formation / personal).
 *  - 'account'  → teammate (Portal Team Access): account-only, no contact_id.
 *  - 'unified'  → legacy per-contact thread (fallback / back-compat).
 */
export type ChatScope =
  | { mode: 'company'; accountId: string; contactId: string; includePersonalNull: boolean }
  | { mode: 'personal'; contactId: string }
  | { mode: 'account'; accountId: string }
  | { mode: 'unified'; contactId: string; accountId: string | null }

/**
 * Real-time chat hook using Supabase Realtime.
 *
 * History: PR 2 Step 6 (2026-05-05) threaded EVERY client by contact_id so the
 * company switcher didn't split the thread. That merged all of a multi-company
 * client's messages into one view AND (for MMLLC members) was the wrong privacy
 * model. 2026-06-24 reintroduces per-company scoping via ChatScope — see
 * lib/portal/chat-scope.ts. accountId/contactId are still passed to the send
 * helpers so a message is tagged to the company currently in view.
 */
export function usePortalChat(scope: ChatScope, accountId: string | null, contactId: string) {
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  // Resolve the read query param, the mark-as-read body, the realtime
  // subscription filters, and the drop-filter plan from the active scope.
  const { queryParam, readBody, realtimeFilters, plan } = resolveScope(scope)

  // Load initial messages + mark as read
  const load = useCallback(async () => {
    setLoading(true)
    setHasMore(true)
    try {
      const res = await fetch(`/api/portal/chat?${queryParam}&limit=50`)
      if (res.ok) {
        const data = await res.json()
        const msgs = data.messages ?? []
        setMessages(msgs)
        setHasMore(msgs.length >= 50)
        fetch('/api/portal/chat/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readBody),
        }).catch(() => {})
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
    // readBody is derived from contactId/accountId (same inputs as queryParam).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, queryParam])

  useEffect(() => {
    load()
  }, [load])

  // Refresh without blanking the message list (keeps existing messages visible)
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/chat?${queryParam}&limit=50`)
      if (res.ok) {
        const data = await res.json()
        const msgs = data.messages ?? []
        setMessages(msgs)
        setHasMore(msgs.length >= 50)
      }
    } catch {
      // silent
    }
  }, [queryParam])

  // Load older messages
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = messages[0]
      // encodeURIComponent is REQUIRED: created_at carries a "+00:00" timezone
      // offset, and an unencoded "+" is decoded as a space server-side, which
      // made this request 500 ("invalid input syntax for timestamp") and the
      // load-older button silently fail. (2026-06-08)
      const res = await fetch(`/api/portal/chat?${queryParam}&limit=50&before=${encodeURIComponent(oldest.created_at)}`)
      if (res.ok) {
        const data = await res.json()
        const older = data.messages ?? []
        setHasMore(older.length >= 50)
        if (older.length > 0) {
          setMessages(prev => [...older, ...prev])
        }
      }
    } catch {
      // silent
    } finally {
      setLoadingMore(false)
    }
  }, [queryParam, messages, loadingMore, hasMore])

  // Subscribe to realtime. Subscriptions are intentionally BROADER than the
  // view (e.g. company scope listens on account_id; personal listens on
  // contact_id), and every delivered row is then run through the plan
  // drop-filter (messageVisibleInPlan) so a message tagged to a DIFFERENT
  // company of the same contact — or another member's personal NULL — can never
  // slip into the view. The drop-filter mirrors the server GET query exactly.
  const planKey = JSON.stringify(plan)
  // planKey rides in the channel NAME so that a change of viewing plan tears
  // down and re-subscribes, exactly as the old effect did when it depended on
  // [realtimeKey, planKey]. The handlers close over `plan` for the privacy
  // drop-filter, so they MUST NOT outlive the plan they were built for.
  const chatChannelName = `portal-chat-${realtimeFilters.map(f => `${f.column}:${f.value}`).join('-') || 'none'}-${planKey}`

  useRealtimeChannel({
    channelName: chatChannelName,
    // A changefeed has no replay: anything that landed while the phone slept is
    // never re-delivered. Refetch the thread instead of resuming the stream.
    onResync: () => { void refresh() },
    setup: (base) => {
    const belongs = (msg: { account_id: string | null; contact_id: string | null }) =>
      plan ? messageVisibleInPlan(plan, msg) : true

    const handleInsert = (payload: { new: unknown }) => {
      const newMessage = payload.new as PortalMessage
      // This hook is client-only. Internal chat-event notes (sender_type='system'
      // carrying the `<!-- chat-event: -->` marker — "Client paid…", "fax to IRS")
      // must never reach the client portal, including via realtime. The server GET
      // excludes them on load; this drops any that arrive live. NOT all system
      // messages: the out-of-office auto-reply is system WITHOUT a marker and IS
      // meant for the client. See sysdoc notification-center-workflow-integration-plan.
      const nm = newMessage as { sender_type?: string; message?: string; account_id: string | null; contact_id: string | null }
      if (nm.sender_type === 'system' && /<!--\s*chat-event:/.test(nm.message ?? '')) return
      if (!belongs(nm)) return // wrong company / someone else's personal — never show
      setMessages(prev => {
        if (prev.some(m => m.id === newMessage.id)) return prev
        return [...prev, newMessage]
      })
    }

    const handleUpdate = (payload: { new: unknown }) => {
      const updated = payload.new as PortalMessage & { deleted_at?: string | null }
      // Client view: a soft-delete removes the message from view entirely (decision #2 — fully vanish).
      if (updated.deleted_at) {
        setMessages(prev => prev.filter(m => m.id !== updated.id))
        return
      }
      if (!belongs(updated)) return
      // Content edit: update the message in place so the client sees the corrected text.
      setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
    }

    // One subscription per scope filter (account_id and/or contact_id). The
    // drop-filter above keeps overlapping deliveries (and cross-company rows)
    // out; ID-based dedup in handleInsert prevents duplicates.
    let channel = base
    for (const f of realtimeFilters) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `${f.column}=eq.${f.value}` }, handleInsert)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `${f.column}=eq.${f.value}` }, handleUpdate)
    }
    return channel
    },
  })

  // Send message. Optional senderContext + tagAccountId let the caller
  // override the picker's tag scope (PR 2 Step 6). Default: senderContext
  // omitted, account_id falls back to the hook's accountId param.
  const sendMessage = useCallback(async (
    message: string,
    attachments?: ChatAttachment[],
    replyToId?: string,
    senderContext?: 'person' | 'company',
    tagAccountId?: string | null,
    topic?: string | null,
  ) => {
    if ((!message.trim() && (!attachments || attachments.length === 0)) || sending) return

    // Resolve account_id for the message: explicit override → hook default → null.
    // 'person' tag forces account_id to null. 'company' requires an account_id.
    let resolvedAccountId: string | null
    if (senderContext === 'person') {
      resolvedAccountId = null
    } else if (senderContext === 'company') {
      resolvedAccountId = tagAccountId ?? accountId ?? null
    } else {
      resolvedAccountId = tagAccountId !== undefined ? tagAccountId : (accountId ?? null)
    }

    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: resolvedAccountId || undefined,
          contact_id: contactId,
          sender_context: senderContext,
          topic: topic || undefined,
          message: message || '',
          attachments: attachments ?? [],
          reply_to_id: replyToId || undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to send')
      }

      const { message: newMsg } = await res.json()
      // Optimistic append, but only if it belongs in the CURRENT view. A message
      // tagged to a different scope than what's on screen (e.g. sent as Personal
      // while a non-sole-owned company is shown) must not flash in then vanish on
      // refresh. The component switches the view to match before sending, so this
      // is a belt-and-braces guard.
      if (newMsg && (!plan || messageVisibleInPlan(plan, newMsg))) {
        setMessages(prev => {
          if (prev.some(m => m.id === newMsg.id)) return prev
          return [...prev, newMsg]
        })
      }
    } catch (error) {
      throw error
    } finally {
      setSending(false)
    }
    // plan is captured fresh each render; planKey in the realtime effect tracks
    // its identity. Excluded here to avoid recreating the sender every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, contactId, sending])

  const topics = Array.from(
    new Set(messages.map(m => m.topic).filter((t): t is string => !!t))
  ).sort()

  return { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore, refresh, topics }
}

type RealtimeFilter = { column: 'account_id' | 'contact_id'; value: string }

/**
 * Translate a ChatScope into the GET query param, the mark-as-read body, the
 * realtime subscription filters, and the plan used for the realtime drop-filter.
 * Single source of truth so read, realtime, and the server stay in lock-step.
 */
function resolveScope(scope: ChatScope): {
  queryParam: string
  readBody: Record<string, unknown>
  realtimeFilters: RealtimeFilter[]
  plan: ChatQueryPlan | null
} {
  switch (scope.mode) {
    case 'company': {
      const plan = buildChatQueryPlan({
        scope: 'company',
        accountId: scope.accountId,
        contactId: scope.contactId,
        includePersonalNull: scope.includePersonalNull,
      })
      const realtimeFilters: RealtimeFilter[] = [{ column: 'account_id', value: scope.accountId }]
      // Only listen on contact_id when personal NULLs ride along (sole-owned),
      // so the viewer's own personal sends arrive live. The drop-filter keeps
      // other-company rows out.
      if (scope.includePersonalNull) realtimeFilters.push({ column: 'contact_id', value: scope.contactId })
      return {
        queryParam: `scope=company&account_id=${scope.accountId}&contact_id=${scope.contactId}`,
        readBody: { scope: 'company', account_id: scope.accountId, contact_id: scope.contactId },
        realtimeFilters,
        plan,
      }
    }
    case 'personal': {
      return {
        queryParam: `scope=personal&contact_id=${scope.contactId}`,
        readBody: { scope: 'personal', contact_id: scope.contactId },
        realtimeFilters: [{ column: 'contact_id', value: scope.contactId }],
        plan: buildChatQueryPlan({ scope: 'personal', accountId: null, contactId: scope.contactId, includePersonalNull: false }),
      }
    }
    case 'account': {
      // Teammate (Portal Team Access): account-only thread, no scope param →
      // server's existing account_id branch. Never includes personal NULLs.
      return {
        queryParam: `account_id=${scope.accountId}`,
        readBody: { account_id: scope.accountId },
        realtimeFilters: [{ column: 'account_id', value: scope.accountId }],
        plan: { mode: 'account', accountId: scope.accountId },
      }
    }
    case 'unified':
    default: {
      // Legacy per-contact thread (no scope param → server unified branch).
      const realtimeFilters: RealtimeFilter[] = [{ column: 'contact_id', value: scope.contactId }]
      if (scope.accountId) realtimeFilters.push({ column: 'account_id', value: scope.accountId })
      return {
        queryParam: `contact_id=${scope.contactId}`,
        readBody: { contact_id: scope.contactId },
        realtimeFilters,
        plan: null, // unified shows the full per-contact set — no drop-filter
      }
    }
  }
}
