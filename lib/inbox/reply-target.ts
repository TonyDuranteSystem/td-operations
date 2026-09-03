import { gmailGet, getHeader, isOwnMailboxAddress, extractAllEmailAddresses, type GmailAPIMessage } from "@/lib/gmail"

/**
 * Resolve which Gmail message a reply/draft is actually targeting — the
 * shared fix for the bug where Reply/Save-draft always addressed whoever
 * sent the THREAD'S NEWEST message, not the message staff had open. Two
 * real incidents (2026-08-05, 2026-09-02) both happened on an ordinary
 * reply where our own prior message simply happened to be newest — not the
 * rarer "staff deliberately opens an old message" case — so the untargeted
 * DEFAULT skips our own messages too, not just the explicit picker.
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
  from: string
  subject: string
  messageIdHeader: string
  references: string
  date: string
  /** Reply-All recipients besides `from` — bare lowercase addresses, our own mailboxes and `from` itself excluded. Empty for a plain reply. */
  cc: string[]
}

/**
 * @param messageId Explicit target from the client (always sent by the
 *   current UI). When omitted (older client, or a defensive fallback),
 *   the newest NON-outbound message in the thread is used instead of the
 *   thread's literal newest message.
 */
export async function resolveReplyTarget(opts: {
  threadId: string
  messageId?: string | null
  mode?: "reply" | "replyAll"
  asUser: string
}): Promise<ResolvedReplyTarget> {
  const { threadId, messageId, asUser } = opts
  const mode = opts.mode === "replyAll" ? "replyAll" : "reply"

  let message: GmailAPIMessage
  // Fetched only in the "no explicit messageId" branch below — reused by
  // the own-address check afterward so a legitimate all-outbound thread
  // doesn't pay for a second Gmail call.
  let threadMessages: GmailAPIMessage[] | null = null

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
    threadMessages = thread.messages
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
  // A card for one of OUR OWN messages is a normal thing to open (scroll up,
  // reply to a point made earlier) — replying to it would address the mail
  // back to ourselves instead of the client. Only a real problem when some
  // OTHER, non-own message exists in this thread that should have been
  // targeted instead: if literally everything here is ours, this IS the
  // legitimate default fallback above, not a mistake, and must be allowed.
  if (isOwnMailboxAddress(from)) {
    const messages = threadMessages ?? (
      (await gmailGet(`/threads/${threadId}`, { format: "full" }, asUser)) as { messages: GmailAPIMessage[] }
    ).messages
    const hasAlternative = messages?.some(
      (m) => m.id !== message.id && !isOwnMailboxAddress(getHeader(m.payload.headers, "From"))
    )
    if (hasAlternative) {
      throw new ReplyTargetError("That message was sent by us — pick a message from the client to reply to.")
    }
  }

  const cc: string[] = []
  if (mode === "replyAll") {
    const to = getHeader(message.payload.headers, "To")
    const ccHeader = getHeader(message.payload.headers, "Cc")
    const fromAddr = extractAllEmailAddresses(from)[0]
    const combined = [...extractAllEmailAddresses(to), ...extractAllEmailAddresses(ccHeader)]
    const seen = new Set<string>()
    for (const addr of combined) {
      if (isOwnMailboxAddress(addr)) continue
      if (fromAddr && addr === fromAddr) continue // already the primary To
      if (seen.has(addr)) continue
      seen.add(addr)
      cc.push(addr)
    }
  }

  return {
    message,
    from,
    subject: getHeader(message.payload.headers, "Subject"),
    messageIdHeader: getHeader(message.payload.headers, "Message-ID"),
    references: getHeader(message.payload.headers, "References"),
    date: getHeader(message.payload.headers, "Date"),
    cc,
  }
}
