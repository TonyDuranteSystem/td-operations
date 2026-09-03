import { gmailGet, getHeader, extractBody, isOwnMailboxAddress, extractAllEmailAddresses, type GmailAPIMessage } from "@/lib/gmail"
import { splitQuotedText } from "@/lib/inbox/email-quote"
import type { ThreadQuoteEntry } from "@/lib/inbox/reply-mime"

/**
 * Resolve which Gmail message a reply/draft is actually targeting — the
 * shared fix for the bug where Reply/Save-draft always addressed whoever
 * sent the THREAD'S NEWEST message, not the message staff had open. Two
 * real incidents (2026-08-05, 2026-09-02) both happened on an ordinary
 * reply where our own prior message simply happened to be newest — not the
 * rarer "staff deliberately opens an old message" case — so the untargeted
 * DEFAULT skips our own messages too, not just the explicit picker.
 *
 * UPDATED 2026-09-03 (dev job 208f39ad): explicitly picking one of OUR OWN
 * sent messages is now ALLOWED (it used to be hard-rejected) — Antonio
 * wanted Reply/Reply-All/Forward available on every message, including
 * sent ones, to add something to a point already made. Replying to our own
 * message now correctly addresses that message's own original recipient(s),
 * never back to us — see `replyToAddresses` vs `quotedFrom` below; collapsing
 * those into one field was the reason outbound messages had to be blocked in
 * the first place, not a mistake to route around.
 *
 * Used by both /api/inbox/reply and /api/inbox/draft — they must resolve
 * identically or a reply and its saved-draft twin could target different
 * messages.
 */

export class ReplyTargetError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface ResolvedReplyTarget {
  /** The single Gmail message every header/body field is derived from. */
  message: GmailAPIMessage
  /**
   * Who the new email is addressed to — bare lowercase addresses, always
   * at least one. For an inbound target this is just the sender. For an
   * OUTBOUND target (one of our own messages) this is that message's own
   * recipient(s), never the message's own From (which is us) — replying
   * to something we sent must go back to whoever we sent it to, not to
   * ourselves (dev job 208f39ad, 2026-09-03: buttons + this fix now cover
   * our own sent messages too, not just the client's).
   */
  replyToAddresses: string[]
  /**
   * Who WROTE the message being quoted underneath the reply — always that
   * message's own From header. Deliberately separate from
   * `replyToAddresses`: for an outbound target those two differ (the quote
   * must still say WE wrote it, even though the new mail addresses the
   * client), and collapsing them into one field was the original design
   * flaw that made outbound messages unsafe to reply to at all.
   */
  quotedFrom: string
  subject: string
  messageIdHeader: string
  references: string
  date: string
  /** Reply-All recipients besides `replyToAddresses` — bare lowercase addresses, our own mailboxes and the primary recipient(s) excluded. Empty for a plain reply. */
  cc: string[]
}

/**
 * One thread message's quotable content, oldest-first — the input to
 * buildReplyMime's 'thread' quote mode: "the conversation so far," i.e.
 * every message STRICTLY BEFORE `excludeMessageId` chronologically (never
 * anything after it — a reply continues from the point it's answering, not
 * messages that logically haven't happened yet relative to it). The caller
 * appends the target message's own quote last, in its correct chronological
 * slot. Body is pre-stripped of its own nested quote via splitQuotedText and
 * capped per-message, mirroring the existing single-message cap. Sorted by
 * internalDate explicitly — the Gmail API's own message order is not
 * guaranteed (the live-fetch message-list route sorts for the same reason).
 */
export async function buildThreadQuotes(threadId: string, asUser: string, excludeMessageId: string): Promise<ThreadQuoteEntry[]> {
  const thread = (await gmailGet(`/threads/${threadId}`, { format: "full" }, asUser)) as { messages: GmailAPIMessage[] }
  const sorted = [...(thread.messages ?? [])].sort(
    (a, b) => parseInt(a.internalDate || "0") - parseInt(b.internalDate || "0")
  )
  const targetIdx = sorted.findIndex((m) => m.id === excludeMessageId)
  const before = targetIdx >= 0 ? sorted.slice(0, targetIdx) : sorted.filter((m) => m.id !== excludeMessageId)
  return before.map((m) => {
    // extractBody (not extractBodyWithType) — it strips HTML down to plain
    // text when the body is HTML, matching what the single-message quote
    // path already does (app/api/inbox/reply/route.ts). Using the
    // HTML-preserving variant here shipped raw `<div>`/`<p>` tags into a
    // real sandbox-verified send before this was caught (dev job 208f39ad).
    const raw = extractBody(m.payload)
    const body = splitQuotedText(raw).main.slice(0, 10_000).trimEnd()
    return {
      from: getHeader(m.payload.headers, "From"),
      date: getHeader(m.payload.headers, "Date"),
      body,
    }
  })
}

/**
 * @param messageId Explicit target from the client (always sent by the
 *   current UI). When omitted (older client, or a defensive fallback),
 *   the newest NON-outbound message in the thread is used instead of the
 *   thread's literal newest message.
 * @param toOverride Staff edited the To field directly (added/removed a
 *   recipient) before sending — replaces the resolved addresses outright.
 *   Must be non-empty; validated by the caller route, not here.
 */
export async function resolveReplyTarget(opts: {
  threadId: string
  messageId?: string | null
  mode?: "reply" | "replyAll"
  asUser: string
  toOverride?: string[]
}): Promise<ResolvedReplyTarget> {
  const { threadId, messageId, asUser } = opts
  const mode = opts.mode === "replyAll" ? "replyAll" : "reply"

  let message: GmailAPIMessage

  if (messageId) {
    message = (await gmailGet(`/messages/${messageId}`, { format: "full" }, asUser)) as GmailAPIMessage
    // The client resolves its own default/explicit target — this is the
    // server's only independent check that it's being handed a message
    // that actually belongs to the conversation being replied in (defends
    // against a stale target surviving a conversation switch, or any other
    // client-side bug landing a wrong messageId here).
    if (message.threadId !== threadId) {
      throw new ReplyTargetError("That message no longer belongs to this conversation — reload and try again.")
    }
  } else {
    const thread = (await gmailGet(`/threads/${threadId}`, { format: "full" }, asUser)) as { messages: GmailAPIMessage[] }
    if (!thread.messages?.length) throw new ReplyTargetError("Conversation not found.", 404)
    const nonOwn = [...thread.messages].reverse().find(
      (m) => !isOwnMailboxAddress(getHeader(m.payload.headers, "From"))
    )
    // Every message in the thread is our own (a fresh outbound email, no
    // reply yet) — nothing else to target, so the literal newest is the
    // only sensible choice; this is not the misdirect case since there is
    // no "someone else" being skipped.
    message = nonOwn ?? thread.messages[thread.messages.length - 1]
  }

  const from = getHeader(message.payload.headers, "From")
  const isOwnMessage = isOwnMailboxAddress(from)

  // Who the reply goes to: an inbound message's own sender (unchanged), or
  // — for one of our own messages — that message's own recipient(s), so a
  // reply never addresses back to us. If we somehow cc'd ourselves on our
  // own outgoing mail, our own addresses are stripped from the candidate
  // list too.
  let replyToAddresses: string[]
  if (isOwnMessage) {
    const to = getHeader(message.payload.headers, "To")
    replyToAddresses = extractAllEmailAddresses(to).filter((a) => !isOwnMailboxAddress(a))
    if (replyToAddresses.length === 0) {
      // Nothing but us on this message (an internal-only send, or a thread
      // where every participant is one of our own aliases) — no real
      // "someone else" to address; only correct fallback left is us.
      replyToAddresses = [from]
    }
  } else {
    replyToAddresses = [from]
  }
  if (opts.toOverride && opts.toOverride.length > 0) {
    replyToAddresses = opts.toOverride
  }

  const cc: string[] = []
  if (mode === "replyAll") {
    const to = getHeader(message.payload.headers, "To")
    const ccHeader = getHeader(message.payload.headers, "Cc")
    const primary = new Set(replyToAddresses)
    const combined = [...extractAllEmailAddresses(to), ...extractAllEmailAddresses(ccHeader)]
    const seen = new Set<string>()
    for (const addr of combined) {
      if (isOwnMailboxAddress(addr)) continue
      if (primary.has(addr)) continue // already a primary recipient
      if (seen.has(addr)) continue
      seen.add(addr)
      cc.push(addr)
    }
  }

  return {
    message,
    replyToAddresses,
    quotedFrom: from,
    subject: getHeader(message.payload.headers, "Subject"),
    messageIdHeader: getHeader(message.payload.headers, "Message-ID"),
    references: getHeader(message.payload.headers, "References"),
    date: getHeader(message.payload.headers, "Date"),
    cc,
  }
}
