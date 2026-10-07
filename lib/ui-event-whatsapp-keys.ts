// Which on-screen queries the 'whatsapp' live-update signal refreshes (dev job 254034f9). Pure — no React, so a unit test can
// guard the one rule that matters here:
//
//   ⛔ NEVER the bare 'inbox-conversations' / 'inbox-stats' (or any Gmail key). Their GET hits Gmail live (~300 calls per load
//   for the default INBOX list) and a storm of them has already starved the Gmail quota and blanked the Inbox
//   (docs/systems/inbox.md; the comment above WAKE_QUERY_KEYS in components/dashboard/ui-event-listener.tsx).
//
// The WhatsApp list shares the 'inbox-conversations' prefix with the Gmail list, but its queryKey's SECOND part is the channel
// ('whatsapp', see components/inbox/conversation-list.tsx), so the two-part key below matches WhatsApp lists only. Its GET
// (/api/inbox/whatsapp/conversations) and the open chat's GET (/api/inbox/whatsapp/messages/[groupId]) read our own database only.

/** The WhatsApp chat list (left). NOT position-dependent anywhere: callers use this name, never an index. */
export const WHATSAPP_LIST_QUERY_KEY: readonly string[] = ['inbox-conversations', 'whatsapp']
/** The open conversation (right) — prefix matches ['whatsapp-messages', groupId]. */
export const WHATSAPP_CHAT_QUERY_KEY: readonly string[] = ['whatsapp-messages']

export const WHATSAPP_LIVE_QUERY_KEYS: ReadonlyArray<readonly string[]> = [WHATSAPP_LIST_QUERY_KEY, WHATSAPP_CHAT_QUERY_KEY]

/** Trailing debounce for a burst of signals (a backfill, several replies finishing together). */
export const WHATSAPP_LIVE_DEBOUNCE_MS = 800
/** …but never postpone the refresh longer than this, however long the burst lasts. */
export const WHATSAPP_LIVE_MAX_WAIT_MS = 4000

/** Query keys that must never be invalidated by any non-Gmail signal. */
export const GMAIL_COST_QUERY_KEYS: readonly string[] = [
  'inbox-conversations', 'inbox-messages', 'inbox-stats', 'gmail-labels', 'client-emails', 'email-unread',
]
