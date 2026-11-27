'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { PortalMessage, ChatAttachment } from '@/lib/types'
import { buildChatQueryPlan, messageVisibleInPlan, type ChatQueryPlan } from '@/lib/portal/chat-scope'
import { mergeRefreshedMessages, parseTimestamp, sortMessagesAscending } from '@/lib/portal/chat-refresh-merge'
import { useWakeSignal } from '@/lib/hooks/use-wake-signal'
import { mergeLiveUpdate } from '@/lib/portal-chats/merge-live-update'
import {
  TOPIC_OLDER_PAGE_SIZE,
  TOPIC_PAGE_SIZE,
  applyMessageToSummary,
  foldFirstPage,
  mergeTabPages,
  mergeTopicView,
  messageInTopic,
  oldestCreatedAt,
  type TopicSummaryEntry,
} from '@/lib/portal/chat-topic-summary'

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
export function usePortalChat(scope: ChatScope, accountId: string | null, contactId: string, activeTopic: string | null = null) {
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  // The conversation's topic list and the OPEN tab's own messages (Antonio, 2026-11-24 — "a topic disappears until I load older messages").
  // `messages` stays the newest 50 of the WHOLE conversation; the tab bar used to be built from it alone. The server now also lists every
  // topic (`topics=1`), and the open tab loads its OWN newest messages (`topic=`) with its own older-page cursor. What the tab shows is
  // `tabMessages` (the window's messages of that topic ∪ the tab's own pages — see mergeTopicView).
  const topicKey = activeTopic ?? ''
  const [topicSummary, setTopicSummary] = useState<{ key: string; topics: TopicSummaryEntry[] | null } | null>(null)
  const [tab, setTab] = useState<TabState>(EMPTY_TAB)
  // Messages the team deleted while this view was open: they must never come back from a tab page that was fetched a moment earlier.
  const deletedIdsRef = useRef<Set<string>>(new Set())
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  // Mirror of `messages` so refresh() can size its refetch to what we already
  // hold WITHOUT taking `messages` as a dependency (that would rebuild the
  // callback on every incoming message).
  const messagesRef = useRef<PortalMessage[]>([])
  // Ref to the current refresh() so the realtime subscribe callback can call it
  // without making refresh a dependency of the subscription effect — that would
  // tear down and rebuild the channel on every render.
  const refreshRef = useRef<(o?: { markRead?: boolean }) => Promise<void>>(async () => {})
  // Fetch sequencing (dev job 05d997f2). Wake, reconnect (SUBSCRIBED) and the
  // initial load can all be in flight at once and resolve out of order. A
  // response may be applied only if nothing NEWER has been applied yet — an
  // older snapshot must never overwrite a newer one. (Deliberately "newer than
  // the last APPLIED", not "is the latest STARTED": if the latest fetch then
  // fails on a flaky network, the earlier good response must still land rather
  // than leave the chat empty.)
  const fetchSeqRef = useRef(0)
  const appliedSeqRef = useRef(0)
  // Live events stamped with a monotonic mark, so each fetch can ask "what
  // arrived / was deleted AFTER I started?" — its snapshot may predate those:
  //  - live: realtime INSERT or the client's own send → keep even if missing;
  //  - deleted: realtime soft-delete → drop even if the snapshot still has it.
  const eventMarkRef = useRef(0)
  const liveMarksRef = useRef<Map<string, number>>(new Map())
  const deletedMarksRef = useRef<Map<string, number>>(new Map())

  // Resolve the read query param, the mark-as-read body, the realtime
  // subscription filters, and the drop-filter plan from the active scope.
  const { queryParam, readBody, realtimeFilters, plan } = resolveScope(scope)
  // The view the component is showing NOW. The chat is not remounted when the
  // client switches company (that would drop the draft and the send popup's
  // state), so a response started for the PREVIOUS company can still resolve
  // after the switch — it must be thrown away, or company A's messages land in
  // company B's view (and then survive every refresh as "older history").
  const currentQueryRef = useRef(queryParam)
  currentQueryRef.current = queryParam
  // Which view the messages on screen belong to (null until the first load
  // lands). Lets the component wait for the NEW company's data before acting
  // on `topics` after a switch.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  // Per-tab unread for this view as the SERVER counts it (all rows, not just
  // the loaded page) — '' = General. Null until the first response (or for
  // views the server doesn't summarise, e.g. teammates).
  const [serverUnread, setServerUnread] = useState<Record<string, number> | null>(null)
  const loadedKeyRef = useRef<string | null>(null)
  const markLoaded = (q: string) => { loadedKeyRef.current = q; setLoadedKey(q) }

  // ── Topic list + the open tab's own pages (see the state above) ──────────────────────────────────────────────────────────────────
  // Only for the scoped views (company / personal / account). The old unscoped 'unified' view keeps the loaded-messages behaviour.
  const topicScoped = scope.mode !== 'unified'
  const tabKey = `${queryParam}|${topicKey}`
  const tabKeyRef = useRef(tabKey)
  tabKeyRef.current = tabKey
  const tabHere = tab.key === tabKey ? tab : null
  // A conversation of fewer than 50 messages is entirely inside the window: nothing more to load, so no extra request. Once a tab has its
  // own pages the store stays on (a live delete can take the window to 49 rows; the tab must not fall back to the window's share).
  const tabStoreEnabled = topicScoped && loadedKey === queryParam && !loading && (messages.length >= TOPIC_PAGE_SIZE || !!tabHere?.first)
  // Another company / personal view: forget everything the tab held (a deletion made while this view was away must not come back from a
  // stale older page — R100).
  useEffect(() => {
    deletedIdsRef.current = new Set()
    setTab(EMPTY_TAB)
  }, [queryParam])

  const summaryAtRef = useRef(0)
  const loadSummary = useCallback(async () => {
    if (!topicScoped) return
    const q = queryParam
    summaryAtRef.current = Date.now()
    try {
      const res = await fetch(`/api/portal/chat?${q}&topics=1`)
      if (!res.ok) return
      const data = await res.json()
      if (q !== currentQueryRef.current) return // the client switched view meanwhile
      setTopicSummary({ key: q, topics: Array.isArray(data.topics) ? (data.topics as TopicSummaryEntry[]) : null })
    } catch {
      // silent — the tabs fall back to the topics of the loaded messages
    }
  }, [queryParam, topicScoped])
  const loadSummaryRef = useRef(loadSummary)
  useEffect(() => { loadSummaryRef.current = loadSummary }, [loadSummary])
  useEffect(() => { void loadSummary() }, [loadSummary])

  // The open tab's newest page. If it slid forward, the rows it no longer covers fold into the older pages; only a real hole (more than a
  // page of new messages) drops them — the next "older" click then reloads from the new start.
  const fetchTabFirst = useCallback(async () => {
    if (!tabStoreEnabled) return
    const key = tabKey
    const q = queryParam
    const topic = topicKey
    const startMark = eventMarkRef.current
    try {
      const res = await fetch(`/api/portal/chat?${q}&topic=${encodeURIComponent(topic)}&limit=${TOPIC_PAGE_SIZE}`)
      if (!res.ok) return
      const data = await res.json()
      if (tabKeyRef.current !== key) return // another tab or company meanwhile
      const deleted = idsSince(deletedMarksRef.current, startMark)
      const msgs = ((data.messages ?? []) as PortalMessage[]).filter(m => !deleted.has(m.id) && !deletedIdsRef.current.has(m.id))
      setTab(prev => {
        const same = prev.key === key
        // the new first page may start later than the old one: keep the rows it no longer covers (see foldFirstPage)
        const folded = foldFirstPage({ prevFirst: same ? prev.first : null, nextFirst: msgs, older: same ? prev.older : [], pageSize: TOPIC_PAGE_SIZE })
        return {
          key, topicKey: topic, first: msgs,
          older: folded.older,
          hasMore: same && !folded.dropped ? prev.hasMore : null,
          loadingOlder: same ? prev.loadingOlder : false,
        }
      })
    } catch {
      // silent — what is already shown stays
    }
  }, [tabStoreEnabled, tabKey, queryParam, topicKey])
  const fetchTabFirstRef = useRef(fetchTabFirst)
  useEffect(() => { fetchTabFirstRef.current = fetchTabFirst }, [fetchTabFirst])
  useEffect(() => { void fetchTabFirst() }, [fetchTabFirst])

  // "Older messages" of the OPEN tab: its own history (100 at a time), paged from the oldest message the TAB itself holds.
  const loadMoreTab = useCallback(async () => {
    const key = tabKey
    const q = queryParam
    const topic = topicKey
    const cur = tab.key === key ? tab : null
    const cursor = cur ? oldestCreatedAt([...(cur.first ?? []), ...cur.older]) : null
    if (!cur || !cursor || cur.loadingOlder) return
    setTab(prev => (prev.key === key ? { ...prev, loadingOlder: true } : prev))
    try {
      // encodeURIComponent is REQUIRED (see loadMore): created_at carries a "+00:00" offset.
      const res = await fetch(`/api/portal/chat?${q}&topic=${encodeURIComponent(topic)}&before=${encodeURIComponent(cursor)}&limit=${TOPIC_OLDER_PAGE_SIZE}`)
      if (!res.ok) throw new Error('older messages')
      const data = await res.json()
      const page = (data.messages ?? []) as PortalMessage[]
      const older = page.filter(m => !deletedIdsRef.current.has(m.id))
      // kept for this tab and its loading flag cleared even if the client moved to another tab meanwhile (else "older" could stay stuck on return)
      setTab(prev => (prev.key !== key ? prev : {
        ...prev,
        older: mergeTabPages(prev.older, older),
        hasMore: page.length >= TOPIC_OLDER_PAGE_SIZE,
        loadingOlder: false,
      }))
    } catch {
      setTab(prev => (prev.key === key ? { ...prev, loadingOlder: false } : prev))
    }
  }, [tab, tabKey, queryParam, topicKey])

  const tabMessages = useMemo<PortalMessage[] | null>(() => {
    if (!tabStoreEnabled) return null
    return mergeTopicView({ topicKey, held: messages, tabPages: [...(tabHere?.first ?? []), ...(tabHere?.older ?? [])] })
      .filter(m => !deletedIdsRef.current.has(m.id))
  }, [tabStoreEnabled, topicKey, messages, tabHere])
  const tabHasMore = tabStoreEnabled && !!tabHere?.first && (tabHere.hasMore ?? tabHere.first.length >= TOPIC_PAGE_SIZE)
  const tabLoadingFirst = tabStoreEnabled && !tabHere?.first
  const tabLoadingOlder = !!tabHere?.loadingOlder

  // Load initial messages + mark as read
  const load = useCallback(async () => {
    setLoading(true)
    setHasMore(true)
    // Switching to a different view: never leave the previous company's
    // messages on screen under the new company's header (e.g. if this load
    // then fails). Same-view reloads keep what is shown.
    if (loadedKeyRef.current !== queryParam) setMessages([])
    const seq = ++fetchSeqRef.current
    const startMark = eventMarkRef.current
    const q = queryParam
    try {
      const res = await fetch(`/api/portal/chat?${q}&limit=50`)
      if (res.ok) {
        const data = await res.json()
        if (q !== currentQueryRef.current) return // the client switched view meanwhile
        if (seq < appliedSeqRef.current) return // something newer is already on screen
        appliedSeqRef.current = seq
        const msgs: PortalMessage[] = data.messages ?? []
        const live = idsSince(liveMarksRef.current, startMark)
        const deleted = idsSince(deletedMarksRef.current, startMark)
        pruneMarks([liveMarksRef.current, deletedMarksRef.current], startMark)
        // Fresh view: keep nothing from before except rows that arrived live
        // while this fetch was in flight. But if this view is ALREADY on screen
        // (a second load of the same view landing late — e.g. React's dev
        // double-mount, or a reload racing the linked-tab search), behave like
        // a refresh: keep the older history already paged in. A blind replace
        // here dropped the linked tab's messages right after they were found
        // (caught in E2E QA: tab selected, chat empty).
        const sameView = loadedKeyRef.current === q
        setMessages(prev => mergeRefreshedMessages({
          fetched: msgs,
          held: sameView ? prev : prev.filter(m => live.has(m.id)),
          limit: sameView ? 50 : Infinity,
          liveIds: live,
          deletedIds: deleted,
        }).messages)
        if (!sameView) setHasMore(msgs.length >= 50)
        else if (msgs.length < 50) setHasMore(false)
        markLoaded(q)
        // No marking here (dev job 05d997f2 Phase 2): opening the chat used to
        // mark EVERY tab read. The component marks only the tab the client is
        // actually looking at, via markRead() below.
        setServerUnread(data.unreadByTopic ?? null)
      }
    } catch {
      // silent
    } finally {
      // A superseded view's load must not clear the spinner of the current one.
      if (q === currentQueryRef.current) setLoading(false)
    }
    // readBody is derived from contactId/accountId (same inputs as queryParam).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, queryParam])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => { messagesRef.current = messages }, [messages])

  // Refresh without blanking the message list (keeps existing messages visible).
  //
  // REPLACES the list rather than merging into it, deliberately. A merge cannot
  // express an ABSENCE: if staff soft-delete a message while the client's socket
  // is down, the row is simply missing from the response, and a union would keep
  // showing it on the client's screen forever — an R100 violation (the client
  // view must FULLY hide a deleted message). Replacement is what expresses the
  // deletion. Two reviewers landed on this independently; do not "optimise" it
  // into a merge.
  //
  // `markRead` exists because the wake path needs it: pulling a new message onto
  // screen without marking it read leaves the client looking at the message AND
  // at an unread badge for it — including on their phone's home-screen icon.
  // Only `load()` used to do this, so a wake refresh alone would light the badge
  // for something visibly on screen (found only by combining two changes).
  //
  // 2026-09-29 (dev job 05d997f2): the replace now goes through
  // mergeRefreshedMessages, which still drops in-window rows missing from the
  // response (deletions) but keeps (a) rows that arrived live after this fetch
  // started and (b) paged-back history older than the fetched window. See that
  // helper for why a blind replace made messages vanish.
  const refresh = useCallback(async (_opts?: { markRead?: boolean }) => {
    // the open tab's own page and the topic list follow the same wake / reconnect / manual reload (the list is skipped when it was
    // read a moment ago — a chat that just opened asks for it once, not twice)
    void fetchTabFirstRef.current()
    if (Date.now() - summaryAtRef.current > 15_000) void loadSummaryRef.current()
    const seq = ++fetchSeqRef.current
    const startMark = eventMarkRef.current
    try {
      // Refetch at least as many as we already hold (the route caps at 100);
      // anything older than that window is kept by the merge, not refetched.
      const limit = Math.min(100, Math.max(50, messagesRef.current.length))
      const q = queryParam
      const res = await fetch(`/api/portal/chat?${q}&limit=${limit}`)
      if (res.ok) {
        const data = await res.json()
        if (q !== currentQueryRef.current) return // the client switched view meanwhile
        if (seq < appliedSeqRef.current) return // something newer is already on screen
        appliedSeqRef.current = seq
        const msgs: PortalMessage[] = data.messages ?? []
        const live = idsSince(liveMarksRef.current, startMark)
        const deleted = idsSince(deletedMarksRef.current, startMark)
        pruneMarks([liveMarksRef.current, deletedMarksRef.current], startMark)
        // Decide against the list as it is NOW (messagesRef lags one render at
        // most; the updater below re-merges against the true latest state).
        // If this view's first load hasn't landed yet (the reconnect refresh
        // won the race), what's on screen may still be the PREVIOUS company's
        // list — merge against nothing, or its rows would be kept as "older
        // history" of this view.
        const sameView = loadedKeyRef.current === q
        const probe = mergeRefreshedMessages({ fetched: msgs, held: sameView ? messagesRef.current : [], limit, liveIds: live, deletedIds: deleted })
        // (Rows that arrived LIVE for this view — e.g. the client's own send —
        // are kept either way.)
        setMessages(prev => mergeRefreshedMessages({ fetched: msgs, held: sameView ? prev : prev.filter(m => live.has(m.id)), limit, liveIds: live, deletedIds: deleted }).messages)
        // Either load or refresh may be the one that lands first for a view.
        if (!sameView) { markLoaded(q); setLoading(false) }
        // A short response means the whole thread fits in it: nothing older exists.
        // A full one with a gap (more arrived while away than the window holds)
        // restarts paging from the fetched window. Otherwise hasMore stays as the
        // paging state (load / loadMore) left it.
        if (msgs.length < limit) setHasMore(false)
        else if (probe.droppedForGap) setHasMore(true)
        if (data.unreadByTopic) setServerUnread(data.unreadByTopic)
        // First response for a NEW view without a summary: never keep the
        // previous company's counts (auto-open would jump to its tab names).
        else if (!sameView) setServerUnread(null)
      }
    } catch {
      // silent
    }
    // readBody is derived from the same inputs as queryParam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryParam])

  useEffect(() => { refreshRef.current = refresh }, [refresh])

  // Catch up when the client comes back to an open portal (dev job 05d997f2).
  // A phone that slept, or a tab left in the background, can hold a realtime
  // socket that died silently — nothing refetched until it noticed and rejoined,
  // so a message the client had just been emailed about could be missing for
  // hours. The portal-wide wake (PortalWakeRefresh) only re-renders the server
  // layout with identical props, which does not re-run this hook. Same wake
  // signal the notification bell uses (20s-away gate + throttle). Marking stays
  // as on every other refresh path.
  useWakeSignal({ onWake: () => { void refreshRef.current() } })

  // Load older messages
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return
    setLoadingMore(true)
    const q = queryParam
    const startMark = eventMarkRef.current
    try {
      const oldest = messages[0]
      // encodeURIComponent is REQUIRED: created_at carries a "+00:00" timezone
      // offset, and an unencoded "+" is decoded as a space server-side, which
      // made this request 500 ("invalid input syntax for timestamp") and the
      // load-older button silently fail. (2026-06-08)
      const res = await fetch(`/api/portal/chat?${q}&limit=50&before=${encodeURIComponent(oldest.created_at)}`)
      if (res.ok) {
        const data = await res.json()
        if (q !== currentQueryRef.current) return // the client switched view meanwhile
        const older: PortalMessage[] = data.messages ?? []
        const deleted = idsSince(deletedMarksRef.current, startMark)
        setHasMore(older.length >= 50)
        if (older.length > 0) {
          // Dedupe: a refresh racing this page may already hold some of these
          // rows; and drop any soft-deleted while this page was loading (R100).
          setMessages(prev => {
            const have = new Set(prev.map(m => m.id))
            return sortMessagesAscending([...older.filter(m => !have.has(m.id) && !deleted.has(m.id)), ...prev])
          })
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
  const realtimeKey = JSON.stringify(realtimeFilters)
  const planKey = JSON.stringify(plan)
  useEffect(() => {
    const supabase = createClient()

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
      liveMarksRef.current.set(newMessage.id, ++eventMarkRef.current)
      // A new team message is unread on its tab until the client looks at it
      // (the component marks it at once if that tab is open and visible).
      // (Skip duplicates: overlapping subscriptions can deliver the same row twice.)
      if (nm.sender_type === 'admin' && !newMessage.read_at && !messagesRef.current.some(m => m.id === newMessage.id)) {
        const key = newMessage.topic ?? ''
        setServerUnread(prev => prev ? { ...prev, [key]: (prev[key] ?? 0) + 1 } : prev)
      }
      setMessages(prev => {
        if (prev.some(m => m.id === newMessage.id)) return prev
        return [...prev, newMessage]
      })
      // the open tab's own first page (only once it is loaded) and the topic list (a new topic gets its tab at once)
      setTab(prev => (prev.first && messageInTopic(newMessage, prev.topicKey) && !prev.first.some(m => m.id === newMessage.id) ? { ...prev, first: [...prev.first, newMessage] } : prev))
      setTopicSummary(prev => (prev ? { ...prev, topics: applyMessageToSummary(prev.topics, newMessage) as TopicSummaryEntry[] | null } : prev))
    }

    const handleUpdate = (payload: { new: unknown }) => {
      const updated = payload.new as PortalMessage & { deleted_at?: string | null }
      // Client view: a soft-delete removes the message from view entirely (decision #2 — fully vanish).
      if (updated.deleted_at) {
        liveMarksRef.current.delete(updated.id)
        deletedMarksRef.current.set(updated.id, ++eventMarkRef.current)
        deletedIdsRef.current.add(updated.id)
        setMessages(prev => prev.filter(m => m.id !== updated.id))
        setTab(prev => ({ ...prev, first: prev.first ? prev.first.filter(m => m.id !== updated.id) : prev.first, older: prev.older.filter(m => m.id !== updated.id) }))
        void loadSummaryRef.current() // a topic may have lost its last message
        return
      }
      if (!belongs(updated)) return
      // Content edit: update the message in place so the client sees the corrected text.
      setMessages(prev => prev.map(m => m.id === updated.id ? mergeLiveUpdate(m, updated) : m))
      setTab(prev => ({ ...prev, first: prev.first ? prev.first.map(m => m.id === updated.id ? mergeLiveUpdate(m, updated) : m) : prev.first, older: prev.older.map(m => m.id === updated.id ? mergeLiveUpdate(m, updated) : m) }))
    }

    // One subscription per scope filter (account_id and/or contact_id). The
    // drop-filter above keeps overlapping deliveries (and cross-company rows)
    // out; ID-based dedup in handleInsert prevents duplicates.
    let channel = supabase.channel(`portal-chat-${realtimeFilters.map(f => `${f.column}:${f.value}`).join('-') || 'none'}`)
    for (const f of realtimeFilters) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `${f.column}=eq.${f.value}` }, handleInsert)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `${f.column}=eq.${f.value}` }, handleUpdate)
    }

    // Status callback, no retry ladder. supabase-js rejoins on its own (the
    // channel schedules a rejoin timer on error/timeout; the socket reconnects
    // with stepped backoff), and a rejoin re-fires SUBSCRIBED on this same
    // channel because its receive hooks survive the resend. An earlier attempt
    // added a custom ladder here and it FOUGHT the library — tearing the channel
    // down on each retry can leave the socket manually disconnected forever.
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        // postgres_changes has NO REPLAY: whatever arrived while we were
        // disconnected is gone, and this hook appends deltas. So refetch
        // authoritative state on every (re)subscribe. Idempotent by design —
        // SUBSCRIBED can fire more than once per rejoin.
        void refreshRef.current()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn(`[portal-chat] channel ${status}`)
      }
    })
    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
    // realtimeFilters/plan are recomputed each render but fully captured by their
    // serialized keys; depending on the keys avoids needless re-subscribes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeKey, planKey])

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
        liveMarksRef.current.set(newMsg.id, ++eventMarkRef.current)
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

  // Tabs = the topics of the loaded messages ∪ every topic the server lists (a topic whose messages are all older has a tab too).
  const topicSummaryHere = topicSummary && topicSummary.key === queryParam ? topicSummary.topics : null
  const topics = Array.from(
    new Set([
      ...messages.map(m => m.topic).filter((t): t is string => !!t),
      ...(topicSummaryHere ?? []).map(e => e.topic).filter(t => !!t),
    ])
  ).sort()

  // Mark ONE tab read, up to the newest message the client has on screen.
  // Returns nothing; broadcasts the client's new unread total so the sidebar
  // and the phone icon follow (window event 'portal-chat-unread').
  const markRead = useCallback(async (topic: string | null, upTo: string) => {
    const key = topic ?? ''
    // Optimistic: those rows are on screen and being read now.
    const now = new Date().toISOString()
    const upToMs = parseTimestamp(upTo)
    const markOne = (m: PortalMessage): PortalMessage =>
      m.sender_type === 'admin' && !m.read_at && !m.client_kept_unread && (m.topic ?? '') === key && parseTimestamp(m.created_at) <= upToMs
        ? { ...m, read_at: now }
        : m
    setMessages(prev => prev.map(markOne))
    setTab(prev => ({ ...prev, first: prev.first ? prev.first.map(markOne) : prev.first, older: prev.older.map(markOne) }))
    setServerUnread(prev => {
      if (!prev) return prev
      const kept = messagesRef.current.filter(m => m.sender_type === 'admin' && m.client_kept_unread && (m.topic ?? '') === key).length
      return { ...prev, [key]: kept }
    })
    try {
      const res = await fetch('/api/portal/chat/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // topic is ALWAYS sent (null = General): an absent key means "mark
        // every tab" to the server, kept only for old cached app versions.
        body: JSON.stringify({ ...readBody, topic, up_to: upTo }),
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        if (typeof data.unread === 'number' && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('portal-chat-unread', { detail: { total: data.unread } }))
        }
      }
    } catch {
      // silent — the next refresh/mark reconciles
    }
    // readBody is derived from the same inputs as queryParam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryParam])

  // True once the messages on screen belong to the view currently selected.
  const ready = !loading && loadedKey === queryParam

  return {
    messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore, refresh, topics, ready, serverUnread, markRead,
    topicSummary: topicSummaryHere, tabMessages, tabHasMore, tabLoadingFirst, tabLoadingOlder, loadMoreTab,
  }
}

type RealtimeFilter = { column: 'account_id' | 'contact_id'; value: string }

/** The open tab's own pages (see usePortalChat): its newest page, older pages, and the cursor bookkeeping. */
interface TabState {
  key: string
  topicKey: string
  first: PortalMessage[] | null
  older: PortalMessage[]
  hasMore: boolean | null
  loadingOlder: boolean
}
const EMPTY_TAB: TabState = { key: '', topicKey: '', first: null, older: [], hasMore: null, loadingOlder: false }

/** Ids whose live-event mark is newer than `since` (i.e. happened after a fetch started). */
function idsSince(marks: Map<string, number>, since: number): Set<string> {
  const out = new Set<string>()
  marks.forEach((mark, id) => { if (mark > since) out.add(id) })
  return out
}

/** Forget events at or before `upTo`. Safe once a response started at `upTo` is
 *  applied: any response applied later started later, so it never needs them. */
function pruneMarks(maps: Array<Map<string, number>>, upTo: number): void {
  for (const marks of maps) {
    marks.forEach((mark, id) => { if (mark <= upTo) marks.delete(id) })
  }
}

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
