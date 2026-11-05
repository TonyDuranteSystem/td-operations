/**
 * Alert kinds — what an alert IS, said by whoever sends it (TD Social, dev job 2072bc3e, Step 2 / pull request C1; Council-reviewed plan of 5 Nov 2026).
 *
 * Every staff alert and every Marketing alert carries ONE of these. The sender functions require it (a missing one is a compile error), they strip it
 * before the web send so the browser gets exactly what it got before, and the phone leg (pull request C2) reads it to decide what a lock screen may show.
 * There is no guessing from the title, the body or the link: a kind that is not on the list is shown as "New notification".
 *
 * WHAT A LOCK SCREEN MAY SHOW, per kind (C2 builds the wording; this file only names the kinds):
 *   - talk_direct_message  the ONLY kind that may show typed text: a direct or group message a person typed in TD Talk, in a chat with no client attached
 *   - talk_room_message    channel / topic message: who and where, no text (the phone does not alert for these; computers keep theirs)
 *   - client_thread_message  a team chat attached to a client: "New message in a client chat", no names, no text
 *   - client_chat          client portal chat: "Chat: <company>" (cleaned), no text, no file name
 *   - client_share_check   the safety alert when staff sent a file or screenshot INTO a client chat: "A file was sent to a client", no names
 *   - claude_reply         "Claude replied", no text (an answer about a client can quote an EIN or a balance)
 *   - shared_item          "<name> shared something with you", no card title
 *   - staff_note           "New staff note", no text
 *   - approval             "A proposal needs a decision", no text
 *   - supabase_notice      the system-written notice text
 *   - test_alert           the "test notification" button
 *   - general_notification "New notification" (also what anything unknown becomes)
 *   - whatsapp_message     a new customer WhatsApp message: the CRM name if the number is linked, else "New WhatsApp message"; never the text
 *   - email_message        a new email in the Inbox: the CRM name if the sender is linked, else "New email in support" / "in antonio"; never the subject
 *   - marketing_*          the lead's name cleaned, Italian wording for Rocco's team, no text
 * WhatsApp and email alerts (pull request D) go to TD Social phones ONLY: they have no web alert, so nothing in the browser senders uses these two kinds.
 */

export const STAFF_ALERT_KINDS = [
  "talk_direct_message",
  "talk_room_message",
  "client_thread_message",
  "client_chat",
  "client_share_check",
  "claude_reply",
  "shared_item",
  "staff_note",
  "approval",
  "supabase_notice",
  "test_alert",
  "general_notification",
  "whatsapp_message",
  "email_message",
] as const

/** Marketing has its own sender and its own subscription table; its kinds can never go through the staff sender (and the other way round). */
export const MARKETING_ALERT_KINDS = [
  "marketing_lead_chat",
  "marketing_team_chat",
  "marketing_lead_moved",
  "marketing_call",
  "marketing_news",
] as const

export type StaffAlertKind = (typeof STAFF_ALERT_KINDS)[number]
export type MarketingAlertKind = (typeof MARKETING_ALERT_KINDS)[number]
export type AlertKind = StaffAlertKind | MarketingAlertKind

export const ALERT_KINDS: readonly AlertKind[] = [...STAFF_ALERT_KINDS, ...MARKETING_ALERT_KINDS]

export function isAlertKind(v: unknown): v is AlertKind {
  return typeof v === "string" && (ALERT_KINDS as readonly string[]).includes(v)
}

/** The facts about a TD Talk thread that decide what an alert from it is. A column that is not loaded is simply "not attached". */
export interface TalkThreadFacts {
  thread_type?: string | null
  account_id?: string | null
  contact_id?: string | null
  lead_id?: string | null
}

/**
 * The kind of an alert that comes from a TD Talk thread. A thread tied to a client is ALWAYS the client kind, whatever its type, because what is said
 * in it can name the client. Otherwise a direct or group chat is the typed-text kind, channels / general / topics are the room kind, and a thread type
 * this code does not know is the generic kind (fails closed: nothing is shown that was not planned).
 */
export function talkAlertKind(t: TalkThreadFacts): StaffAlertKind {
  if (t.account_id || t.contact_id || t.lead_id) return "client_thread_message"
  switch (t.thread_type) {
    case "dm":
    case "group":
      return "talk_direct_message"
    case "channel":
    case "general":
    case "discussion":
      return "talk_room_message"
    default:
      return "general_notification"
  }
}
