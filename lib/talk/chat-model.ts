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

export interface TalkMessage {
  id: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
  deleted_at?: string | null
  attachments?: TalkAttachment[] | null
  /** Slack-thread reply inside a channel — never present in a direct message. */
  root_id?: string | null
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
  return directMessages(dms)[0]?.id ?? null
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

/** Oldest-to-newest messages grouped under day headings. Direct messages have no Slack threads, so a reply row (root_id set) is skipped defensively. */
export function groupByDay(messages: TalkMessage[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = []
  for (const m of messages) {
    if (m.root_id) continue
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
