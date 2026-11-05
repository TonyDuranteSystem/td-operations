/**
 * TD Social — what a lock screen may show, per kind of alert (pure; dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026).
 *
 * THE RULE: who, never what. A lock screen is visible to anyone near the phone, so almost every kind shows fixed words. The ONLY kind that shows typed
 * text is a direct or group message a person typed in TD Talk in a chat with no client attached (`talk_direct_message`; the sender decides the kind, and
 * `talkAlertKind` makes any chat tied to a client the client kind). Everything else shows generic words, plus at most one cleaned NAME the sender passes
 * on purpose (`phoneName`: a company, a lead or a person's name). Nothing is guessed from the web title, the body or the link. A kind that is not on the
 * list shows "New notification". Names are cleaned (controls, line breaks and direction marks removed, cut by whole characters) because a client or a
 * sender can type anything as a name.
 *
 * Italian wording for Marketing (Rocco's team); English for staff.
 */
import { isAlertKind, type AlertKind } from "@/lib/push/alert-kinds"
import { cleanLabel } from "@/lib/app/clean-text"
import type { TabId } from "@/lib/app/tabs"

export interface PhoneAlertText { title: string; body: string }

export interface WordingInput {
  /** the kind as the sender said it (a value that is not on the list is shown as a generic alert) */
  kind: unknown
  /** the web alert's own title and body: used ONLY for the typed-text kind and the system-written notice */
  title: string
  body: string
  /** one name the sender chose to put on the lock screen (cleaned here) */
  name?: string | null
  /** true for a direct or group chat message (TD Talk's own flag) */
  dm?: boolean
}

export const NAME_MAX = 40
export const TITLE_MAX = 60
export const BODY_MAX = 140
const GENERIC: PhoneAlertText = { title: "New notification", body: "" }

/** The TD Social tab an alert belongs to (null = none). A person who muted that tab gets no phone alert for it. */
export function phoneTabFor(kind: AlertKind): TabId | null {
  switch (kind) {
    case "talk_direct_message":
    case "claude_reply":
    case "shared_item":
      return "talk"
    case "client_chat":
    case "client_thread_message":
      return "portal"
    case "marketing_lead_chat":
    case "marketing_team_chat":
    case "marketing_lead_moved":
    case "marketing_call":
    case "marketing_news":
      return "marketing"
    default:
      return null
  }
}

/**
 * The text for the phone, or null when this alert does not go to the phone at all.
 *  - Channel / topic messages never go (TD Social's TD Talk tab shows direct and group chats only; computers keep their alerts).
 *  - Claude's replies and shared items go only when they are a direct or group chat message (`dm`), for the same reason.
 */
export function phoneWording(input: WordingInput): PhoneAlertText | null {
  if (!isAlertKind(input.kind)) return GENERIC
  const name = cleanLabel(input.name, NAME_MAX)
  switch (input.kind) {
    case "talk_direct_message": {
      const title = cleanLabel(input.title, TITLE_MAX)
      return title ? { title, body: cleanLabel(input.body, BODY_MAX) } : GENERIC
    }
    case "talk_room_message":
      return null
    case "claude_reply":
      return input.dm === true ? { title: "Claude replied", body: "" } : null
    case "shared_item":
      if (input.dm !== true) return null
      return { title: name ? `${name} shared something with you` : "Something was shared with you", body: "" }
    case "client_thread_message":
      return { title: "New message in a client chat", body: "" }
    case "client_chat":
      return { title: `Chat: ${name || "a client"}`, body: "" }
    case "staff_note":
      return { title: "New staff note", body: "" }
    case "approval":
      return { title: "A proposal needs a decision", body: "" }
    case "supabase_notice": {
      // written by the system, never by a person or a client
      const title = cleanLabel(input.title, TITLE_MAX)
      return title ? { title, body: cleanLabel(input.body, BODY_MAX) } : GENERIC
    }
    case "test_alert":
      return { title: "Test notification", body: "Alerts are working." }
    case "marketing_lead_chat":
      return { title: name ? `Nuovo messaggio · ${name}` : "Nuovo messaggio", body: "" }
    case "marketing_team_chat":
      return { title: name ? `Nuovo messaggio da ${name}` : "Nuovo messaggio nel team", body: "" }
    case "marketing_lead_moved":
      return { title: name ? `Chiamata spostata · ${name}` : "Chiamata spostata", body: "" }
    case "marketing_call":
      return { title: name ? `Nuova chiamata · ${name}` : "Nuova chiamata", body: "" }
    case "marketing_news":
      return { title: "Novità in TD Marketing", body: "" }
    case "general_notification":
    default:
      return GENERIC
  }
}
