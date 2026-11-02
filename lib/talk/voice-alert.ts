/**
 * TD Talk — the spoken alert for a new direct or group message (pure; Antonio, 30 Oct 2026: "when I receive a message from Luca I don't want the beep, I want the voice that says
 * 'New Luca message in TD Talk'; it has to work for Luca as well").
 * The browser reads the phrase out while a TD page is open and the person has Sound on (a page may speak only after a click, and a closed app cannot speak: the phone push covers that).
 * Own storage key, never Marketing's `tdm_voice`: switching one on must not switch the other on. No DOM here: the screen part is `components/talk/talk-voice.tsx`.
 */

/** Where the person's choice lives (this browser only). Missing = ON: the voice replaces the beep unless the person turned it off. */
export const TALK_VOICE_KEY = "td_talk_voice"

/** The same phrase from the same sender (matched by id, not by first name) inside this window is said once (a burst of messages is not read out ten times). */
export const TALK_VOICE_REPEAT_MS = 4_000

/** "Luca Rossi" -> "Luca"; an empty name stays empty. */
export function talkFirstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

/** The words, always English: "New Luca message in TD Talk". A sender without a name is said as "team" ("New team message in TD Talk"). */
export function talkVoicePhrase(senderName: string | null | undefined): string {
  return `New ${talkFirstName(senderName) || "team"} message in TD Talk`
}

/** The group where the team posts every new fix and feature (Antonio, 30 Oct 2026). Found by its name; a message in it always says the feature phrase, whoever wrote it. */
export const IMPLEMENTATION_CHAT_TITLE = "New implementation"
export const TALK_FEATURE_PHRASE = "New feature posted in TD Talk"
/** A client wrote in a portal chat (Antonio, 30 Oct 2026: "new message from client"). Generic on purpose: no company name to read out. */
export const CLIENT_MESSAGE_PHRASE = "New message from client"

/** A new bug posted in the #td-bug channel (Antonio, 2 Nov 2026: "add the voice for new td bug"). Only a NEW bug (a top-level post) says it; a reply inside a bug keeps the beep. */
export const TD_BUG_CHANNEL_SLUG = "td-bug"
export const TD_BUG_PHRASE = "New TD bug"

/** Is this message a brand-new bug: in the #td-bug channel and not a reply (no root message)? Case does not matter. */
export function isNewTdBugPost(channelLabel: string | null | undefined, rootId: string | null | undefined): boolean {
  return (channelLabel ?? "").trim().toLowerCase() === TD_BUG_CHANNEL_SLUG && !rootId
}

/** A reply inside a bug or any other channel thread (Antonio, 2 Nov 2026: "reply voice in td bug or wherever"). */
export const TD_BUG_REPLY_PHRASE = "New TD bug reply"
export const CHANNEL_REPLY_PHRASE = "New reply"

/** The words for a channel post: new bug, bug reply, or a reply elsewhere; null when it keeps the beep (a top-level post in another channel). */
export function channelVoicePhrase(channelLabel: string | null | undefined, rootId: string | null | undefined): string | null {
  const isBugChannel = (channelLabel ?? "").trim().toLowerCase() === TD_BUG_CHANNEL_SLUG
  if (!rootId) return isBugChannel ? TD_BUG_PHRASE : null
  return isBugChannel ? TD_BUG_REPLY_PHRASE : CHANNEL_REPLY_PHRASE
}

/** Is this group the "New implementation" chat? Case and extra spaces do not matter. */
export function isImplementationChat(title: string | null | undefined): boolean {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase() === IMPLEMENTATION_CHAT_TITLE.toLowerCase()
}

/** Is the voice on? Anything but the exact stored word "off" counts as on. */
export function talkVoiceIsOn(stored: string | null | undefined): boolean {
  return stored !== "off"
}

/** Should this phrase be said now, given the last one said and when? */
export function shouldSpeakTalkPhrase(last: { key: string; at: number } | null, key: string, now: number, repeatMs = TALK_VOICE_REPEAT_MS): boolean {
  if (!last) return true
  return !(last.key === key && now - last.at < repeatMs)
}
