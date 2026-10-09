/**
 * Pure rules for the TD Talk chat screen (dev job c1e326dd) — no React, no network, unit-tested.
 *
 * TD Talk is a WhatsApp-style chat for the team, NOT the Team Workspace: it shows people (direct messages) and the
 * conversation with one of them. Everything it reads and writes is the existing Team Chat data
 * (`internal_threads` rows of type 'dm' and their `internal_messages`).
 */

export interface TalkThread {
  id: string
  thread_type: string
  dm_key: string | null
  /** A group's name (the thread title). */
  title?: string | null
  /** A group's member ids (the server adds them to the thread list). */
  members?: string[] | null
  archived_at: string | null
  last_activity_at: string | null
  unread_count?: number
}

export interface TalkMember {
  id: string
  name: string
}

export interface TalkAttachment {
  url: string
  name: string
  mime_type?: string
  size?: number
}

export interface TalkReaction {
  emoji: string
  reactor_id: string
  reactor_name?: string
}

export interface TalkReplyPreview {
  id: string
  message: string
  sender_name: string
  deleted_at: string | null
}

export interface TalkMessage {
  id: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
  edited_at?: string | null
  deleted_at?: string | null
  attachments?: TalkAttachment[] | null
  reactions?: TalkReaction[] | null
  /** The message this one quotes (a reply), and a preview of it as the server sends it. */
  reply_to_id?: string | null
  reply_to_preview?: TalkReplyPreview | null
  /** Slack-thread reply inside a channel — never present in a direct message. */
  root_id?: string | null
}

export function isGroupThread(t: Pick<TalkThread, 'thread_type'>): boolean {
  return t.thread_type === 'group'
}

/** Everything TD Talk shows as a chat — direct messages AND groups — newest activity first. Archived ones are hidden. */
export function chatThreads(threads: TalkThread[]): TalkThread[] {
  return threads
    .filter(t => (t.thread_type === 'dm' || t.thread_type === 'group') && !t.archived_at)
    .sort((a, b) => Date.parse(b.last_activity_at ?? '') - Date.parse(a.last_activity_at ?? '') || 0)
}

/** Direct-message threads only, newest activity first. Archived ones are hidden. */
export function directMessages(threads: TalkThread[]): TalkThread[] {
  return threads
    .filter(t => t.thread_type === 'dm' && !t.archived_at)
    .sort((a, b) => Date.parse(b.last_activity_at ?? '') - Date.parse(a.last_activity_at ?? '') || 0)
}

/** The other person in a direct message (`dm_key` is "idA:idB", sorted). */
export function otherUserId(dmKey: string | null | undefined, me: string | null | undefined): string | null {
  if (!dmKey || !me) return null
  const other = dmKey.split(':').find(id => id && id !== me)
  return other ?? null
}

export function dmName(t: TalkThread, me: string | null, members: TalkMember[]): string {
  const other = otherUserId(t.dm_key, me)
  return (other && members.find(m => m.id === other)?.name) || 'Teammate'
}

/** The name shown for a chat: the other person for a direct message, the group's name for a group. */
export function chatName(t: TalkThread, me: string | null, members: TalkMember[]): string {
  if (isGroupThread(t)) return (t.title ?? '').trim() || 'Group'
  return dmName(t, me, members)
}

/** "Luca, Jodi, You" — a group's members by name, me last. Unknown ids are skipped. */
export function groupMemberNames(memberIds: readonly string[] | null | undefined, me: string | null, members: TalkMember[]): string {
  const names: string[] = []
  for (const id of memberIds ?? []) {
    if (id === me) continue
    const n = members.find(m => m.id === id)?.name
    if (n) names.push(n)
  }
  if (me && (memberIds ?? []).includes(me)) names.push('You')
  return names.join(', ')
}

/** Teammates NOT yet in a group (who can be added). */
export function membersNotInGroup(memberIds: readonly string[] | null | undefined, members: TalkMember[]): TalkMember[] {
  const have = new Set(memberIds ?? [])
  return members.filter(m => !have.has(m.id))
}

/** WhatsApp-style colour for a person's name inside a group (stable per id). */
const NAME_COLORS = ['text-rose-600', 'text-indigo-600', 'text-emerald-700', 'text-amber-700', 'text-sky-700', 'text-violet-700', 'text-teal-700', 'text-fuchsia-700']
export function nameColorFor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return NAME_COLORS[h % NAME_COLORS.length]
}

/**
 * Which chat the app opens on. A valid requested chat (a tapped notification, a link) wins; then the one open last
 * time on this phone; then the chat with the most recent activity. Null when there is no direct message at all.
 */
export function startThreadId(
  dms: TalkThread[],
  opts: { wanted?: string | null; lastOpened?: string | null } = {},
): string | null {
  const ids = new Set(dms.map(t => t.id))
  if (opts.wanted && ids.has(opts.wanted)) return opts.wanted
  if (opts.lastOpened && ids.has(opts.lastOpened)) return opts.lastOpened
  return chatThreads(dms)[0]?.id ?? null
}

/** Teammates this person has no direct message with yet (so the list can offer to start one). */
export function membersWithoutChat(dms: TalkThread[], me: string | null, members: TalkMember[]): TalkMember[] {
  const have = new Set(dms.map(t => otherUserId(t.dm_key, me)).filter((x): x is string => !!x))
  return members.filter(m => m.id !== me && !have.has(m.id))
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

// ─── Messages ────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Local calendar day of a timestamp, e.g. "2026-10-09" (the grouping key). */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const today = dayKey(now.toISOString())
  const yesterday = dayKey(new Date(now.getTime() - 24 * 3_600_000).toISOString())
  const k = dayKey(iso)
  if (k === today) return 'Today'
  if (k === yesterday) return 'Yesterday'
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`}`
}

/** Time of day in 24h, like the rest of the CRM ("14:05"). */
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface DayGroup {
  key: string
  label: string
  messages: TalkMessage[]
}

/**
 * Oldest-to-newest messages grouped under day headings. EVERY message is shown: the server stamps `root_id` on any
 * quoted reply (even in a direct message, where it is just an artifact of the Slack-style threading — the CRM's own
 * direct-message view shows replies inline too), so `root_id` must NOT hide a message here.
 */
export function groupByDay(messages: TalkMessage[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = []
  for (const m of messages) {
    const key = dayKey(m.created_at)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.messages.push(m)
    else groups.push({ key, label: dayLabel(m.created_at, now), messages: [m] })
  }
  return groups
}

/** WhatsApp-style tick for MY message: seen once the other person's read pointer has reached it, else just sent. */
export function seenState(
  m: { created_at: string },
  peerReadAt: string | null | undefined,
): 'sent' | 'seen' {
  if (!peerReadAt) return 'sent'
  const read = Date.parse(peerReadAt)
  const sent = Date.parse(m.created_at)
  if (Number.isNaN(read) || Number.isNaN(sent)) return 'sent'
  return sent <= read ? 'seen' : 'sent'
}

/**
 * Group ticks: my message is "seen" once EVERY other member has read up to it (blue double tick); until then it is just sent.
 * `reads` maps a member id to when they last read the chat. A member with no read row has not seen anything.
 */
export function seenByAll(
  m: { created_at: string },
  otherMemberIds: readonly string[],
  reads: Readonly<Record<string, string | null | undefined>>,
): boolean {
  if (otherMemberIds.length === 0) return false
  const sent = Date.parse(m.created_at)
  if (Number.isNaN(sent)) return false
  return otherMemberIds.every(id => {
    const r = reads[id]
    const t = r ? Date.parse(r) : NaN
    return !Number.isNaN(t) && sent <= t
  })
}

// ─── Attachments ─────────────────────────────────────────────────────────

const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|aac|webm|opus)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|avif)$/i

export function isAudio(a: Pick<TalkAttachment, 'name' | 'mime_type'>): boolean {
  if (a.mime_type) return a.mime_type.toLowerCase().startsWith('audio/')
  return AUDIO_EXT.test(a.name || '')
}

export function isImage(a: Pick<TalkAttachment, 'name' | 'mime_type'>): boolean {
  if (a.mime_type) return a.mime_type.toLowerCase().startsWith('image/')
  return IMAGE_EXT.test(a.name || '')
}

export function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "0:07" for a recording timer. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ─── Links in text ───────────────────────────────────────────────────────

export interface TextPart {
  text: string
  href?: string
}

/** Split text into plain pieces and http(s) links — nothing else is ever made clickable. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = []
  const re = /https?:\/\/[^\s<>"']+/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let url = m[0]
    // trailing punctuation belongs to the sentence, not the link
    const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? ''
    if (trail) url = url.slice(0, url.length - trail.length)
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    parts.push({ text: url, href: url })
    last = m.index + url.length
    re.lastIndex = last
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts.length ? parts : [{ text }]
}

// ─── Reactions, replies, edit/delete, search ──────────────────────────────

/** The quick reactions offered on a message (WhatsApp's set). */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

export interface ReactionPill {
  emoji: string
  count: number
  mine: boolean
}

/** Reactions grouped by emoji, in the order first used; `mine` = I reacted with it (tapping it again removes it). */
export function reactionSummary(reactions: TalkReaction[] | null | undefined, meId: string | null): ReactionPill[] {
  const order: string[] = []
  const map = new Map<string, ReactionPill>()
  for (const r of reactions ?? []) {
    if (!r || !r.emoji) continue
    let pill = map.get(r.emoji)
    if (!pill) { pill = { emoji: r.emoji, count: 0, mine: false }; map.set(r.emoji, pill); order.push(r.emoji) }
    pill.count++
    if (meId && r.reactor_id === meId) pill.mine = true
  }
  return order.map(e => map.get(e)!)
}

/** A short one-line text for a message: its text, else what it carries ("Voice message", "Photo", "File"). */
export function snippet(m: Pick<TalkMessage, 'message' | 'attachments' | 'deleted_at'>, max = 80): string {
  if (m.deleted_at) return 'Message deleted'
  const text = (m.message ?? '').replace(/\s+/g, ' ').trim()
  if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text
  const a = m.attachments?.[0]
  if (!a) return 'Message'
  if (isAudio(a)) return '🎤 Voice message'
  if (isImage(a)) return '📷 Photo'
  return `📎 ${a.name || 'File'}`
}

/** What a quoted message shows: the server's preview when it sent one, else the quoted message if it is loaded. */
export function quotedPreview(
  m: Pick<TalkMessage, 'reply_to_id' | 'reply_to_preview'>,
  byId: Map<string, TalkMessage>,
): { id: string; sender_name: string; text: string } | null {
  if (!m.reply_to_id) return null
  const loaded = byId.get(m.reply_to_id)
  if (loaded) return { id: loaded.id, sender_name: loaded.sender_name, text: snippet(loaded) }
  const p = m.reply_to_preview
  if (p) return { id: p.id, sender_name: p.sender_name, text: snippet({ message: p.message, deleted_at: p.deleted_at }) }
  return { id: m.reply_to_id, sender_name: '', text: 'Message' }
}

/** Edit: my own text message that is not deleted and carries no file (the server only edits the text). */
export function canEdit(m: TalkMessage, meId: string | null): boolean {
  return !!meId && m.sender_id === meId && !m.deleted_at && !(m.attachments && m.attachments.length > 0) && !!m.message
}

/** Delete: my own message that is not already deleted (the server soft-deletes; a tombstone stays). */
export function canDelete(m: TalkMessage, meId: string | null): boolean {
  return !!meId && m.sender_id === meId && !m.deleted_at
}

/** Messages matching a search, newest first (case-insensitive; matches the text and attachment names; skips deleted ones). Needs 2+ characters. */
export function matchMessages(messages: TalkMessage[], query: string): TalkMessage[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  return messages
    .filter(m => !m.deleted_at && (
      (m.message ?? '').toLowerCase().includes(q) ||
      (m.attachments ?? []).some(a => (a.name ?? '').toLowerCase().includes(q))
    ))
    .reverse()
}

// ─── Keeping the list honest while it refreshes ───────────────────────────

/**
 * Combine what the screen already has with a fresh snapshot from the server. The snapshot wins for every message it
 * contains; a local message the snapshot does NOT contain is kept when it is not older than the snapshot's newest
 * message (it was sent or received after the snapshot was taken). Result is oldest to newest.
 */
export function mergeSnapshot(local: TalkMessage[], snapshot: TalkMessage[]): TalkMessage[] {
  if (snapshot.length === 0) return local.length === 0 ? snapshot : local
  const have = new Set(snapshot.map(m => m.id))
  const newest = Math.max(...snapshot.map(m => Date.parse(m.created_at) || 0))
  const extra = local.filter(m => !have.has(m.id) && (Date.parse(m.created_at) || 0) >= newest)
  if (extra.length === 0) return snapshot
  return [...snapshot, ...extra].sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0))
}

/** A cheap fingerprint of everything on screen that can change (text, edits, deletes, reactions, files) — equal means "nothing to redraw". */
export function messageSignature(list: TalkMessage[]): string {
  return list
    .map(m => `${m.id}|${m.message ?? ''}|${m.edited_at ?? ''}|${m.deleted_at ?? ''}|${(m.reactions ?? []).map(r => `${r.emoji}${r.reactor_id}`).join(',')}|${(m.attachments ?? []).length}`)
    .join('\n')
}

// ─── "typing…" ────────────────────────────────────────────────────────────

export type TypingKind = 'typing' | 'recording'

/** A "typing…" line disappears by itself this long after the last signal (the other person stopped, closed the app, lost signal). */
export const TYPING_EXPIRES_MS = 4_000
/** How often a person's own typing is announced while they keep typing. */
export const TYPING_SEND_GAP_MS = 2_500

export function typingLabel(kind: TypingKind | null | undefined, who?: string | null): string {
  const base = kind === 'recording' ? 'recording a voice message…' : kind === 'typing' ? 'typing…' : ''
  if (!base) return ''
  // in a group the line names the person ("Luca is typing…"); in a direct message the name is already in the header
  return who ? `${who} is ${base}` : base
}

/** True when a new "typing" signal should go out: never twice within the gap. */
export function shouldAnnounceTyping(lastSentAt: number | null, now: number, gap: number = TYPING_SEND_GAP_MS): boolean {
  return lastSentAt === null || now - lastSentAt >= gap
}

/** Reads a received signal defensively: only a different person's signal of a known kind counts. */
export function parseTypingSignal(payload: unknown, meId: string | null): { userId: string; kind: TypingKind } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { user_id?: unknown; kind?: unknown }
  if (typeof p.user_id !== 'string' || !p.user_id || p.user_id === meId) return null
  const kind: TypingKind = p.kind === 'recording' ? 'recording' : 'typing'
  return { userId: p.user_id, kind }
}
