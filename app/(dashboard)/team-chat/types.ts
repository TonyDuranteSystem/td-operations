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
  reply_to_preview: ReplyPreview | null
  reactions: Reaction[] | null
  card: TeamCardData | null
  mentions: string[] | null
  deleted_at: string | null
  deleted_by: string | null
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
  dm_key: string | null
  resolved_at: string | null
  archived_at: string | null
  created_by: string
  created_at: string
  last_activity_at: string | null
  unread_count: number
  last_message: string | null
  last_message_at: string | null
  last_sender_name: string | null
  label: string
}

export interface TeamMember {
  id: string
  email: string | null
  name: string
  role: 'admin' | 'team'
  handles: string[]
}
