import type { ChatAttachment } from '@/lib/types'

export interface TeamCardData {
  kind: 'account' | 'invoice' | 'document' | 'task' | 'client_message' | 'link'
  title: string
  subtitle?: string
  url?: string
  color?: string
  entity_type?: string
  entity_id?: string
}

export interface Reaction {
  emoji: string
  reactor_id: string
  reactor_name?: string
  created_at?: string
}

export interface ReplyPreview {
  id: string
  message: string
  sender_name: string
  deleted_at: string | null
}

export interface TeamMsg {
  id: string
  thread_id: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
  edited_at: string | null
  original_message: string | null
  pinned_at: string | null
  pinned_by: string | null
  attachments: ChatAttachment[] | null
  attachment_url: string | null
  attachment_name: string | null
  reply_to_id: string | null
  /** Slack thread root: NULL = this message IS a root (or a plain top-level
   *  message with no replies); set = this is a reply belonging to that thread. */
  root_id: string | null
  reply_to_preview: ReplyPreview | null
  reactions: Reaction[] | null
  card: TeamCardData | null
  mentions: string[] | null
  deleted_at: string | null
  deleted_by: string | null
}

/** Per-root Slack-thread metadata, keyed by root message id (from GET thread_meta). */
export interface ThreadMeta {
  reply_count: number
  last_reply_at: string
  last_reply_sender: string
  unread: boolean
  /** Management status (defaults 'todo' = untriaged/Open). */
  status?: 'todo' | 'in_progress' | 'waiting' | 'handled'
  assignee_id?: string | null
}

/** A row in the per-channel Threads management panel (from GET `threads`). */
export interface ThreadListItem {
  root_id: string
  title: string
  sender_name: string | null
  reply_count: number
  last_reply_at: string | null
  unread: boolean
  status: 'todo' | 'in_progress' | 'waiting' | 'handled'
  assignee_id: string | null
  following: boolean
  /** Hidden from the lists and the stream, reversibly. */
  archived: boolean
  /** Who hid it and when — an archive removes it from EVERYONE's view. */
  archived_at: string | null
  archived_by: string | null
  /** Who opened the thread — Delete is offered only to them. */
  root_sender_id: string | null
  /** Personal "bring forward" flag — only the caller sees it. */
  later: boolean
}

/** A row in the personal "bring forward" list (GET /api/team/later-threads). */
export interface LaterThread {
  root_message_id: string
  thread_id: string
  channel_label: string
  title: string
  status: 'todo' | 'in_progress' | 'waiting' | 'handled'
  unread: boolean
  flagged_at: string
}

/** A thread card on the cross-channel Board (from GET /api/team/all-threads). */
export interface BoardThread {
  root_message_id: string
  thread_id: string
  channel_label: string
  title: string
  status: 'todo' | 'in_progress' | 'waiting' | 'handled'
  assignee_id: string | null
  reply_count: number
  last_activity_at: string | null
  unread: boolean
  following: boolean
  /** Only ever true when the board explicitly asked for archived threads. */
  archived?: boolean
  /** Personal "bring forward" flag. */
  later?: boolean
}

export type ThreadType = 'general' | 'channel' | 'discussion' | 'dm'

export interface TeamThread {
  id: string
  thread_type: ThreadType
  title: string | null
  channel_name: string | null
  channel_slug: string | null
  description: string | null
  color: string | null
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  dm_key: string | null
  /** Discussion topic (e.g. "Billing"); null for topic-less or non-discussions. */
  topic: string | null
  /** Stable client grouping key: 'account:<id>' | 'contact:<id>' | 'lead:<id>' | 'internal'; null for channels/dm/general. */
  client_key: string | null
  /** Client group header name; 'Internal / No client' when unanchored. */
  client_label: string | null
  resolved_at: string | null
  /** Client-conversation lifecycle: null = open, 'solved' = done, 'closed' = dropped. */
  resolution: 'solved' | 'closed' | null
  archived_at: string | null
  created_by: string
  created_at: string
  last_activity_at: string | null
  parent_channel_id: string | null
  work_status: 'todo' | 'in_progress' | 'waiting' | 'handled'
  later: boolean
  unread_count: number
  mention_count: number
  last_message: string | null
  last_message_at: string | null
  last_sender_name: string | null
  label: string
  /** Server-computed client bucket for the Conversations sidebar; null for non-discussions. */
  client_bucket: 'active_client' | 'lead' | 'partner' | 'individual' | 'suspended' | 'cancelled' | 'offboarded' | 'internal' | null
  /** Lead pipeline stage for lead-anchored conversations (e.g. "Offer Sent"), else null. */
  lead_status: string | null
}

export interface TeamMember {
  id: string
  email: string | null
  name: string
  role: 'admin' | 'team'
  handles: string[]
}

export interface SlackChannel {
  id: string
  name: string | null
  is_private: boolean
  is_archived: boolean
  topic: string | null
  num_members: number | null
  last_message_at: string | null
}

export interface SlackMsg {
  ts: string
  thread_ts: string | null
  slack_user_id: string | null
  author_name: string | null
  display_author: string
  text: string
  edited: boolean
  posted_at: string | null
  deep_link: string
}
