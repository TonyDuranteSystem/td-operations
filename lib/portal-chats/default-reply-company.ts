// Where a reply goes by default in a PERSON's chat (Antonio, 2026-11-26, dev job 8d077f3b, his choice "A1").
//
// Before: always "Personal" (the 2026-08-07 fix, after replies meant for one person landed in a chat the whole company can read). In practice clients
// write from a company far more than as Personal (last 60 days: 1,808 vs 99), so the answer usually left the place they wrote from. Now the reply
// starts where the client's LATEST message was written: that company when it was written from a company, Personal otherwise. Staff can still change it
// (the chips on the website, "Reply to ... Change" in the app), and once they do, their pick is kept until they open another conversation.
//
// Safe fallbacks, all to Personal: no client message yet, a message with no company tag, a company this chat does not list, a closed company (nothing
// can be sent there). The "Reply to" line and the Before-you-send pop-up always show where it goes before anything leaves.

export interface DefaultReplyMessage {
  sender_type: string
  sender_context?: 'person' | 'company' | null
  account_id?: string | null
  created_at: string
  /** a chat message the server hid is never "the latest thing the client said" */
  deleted_at?: string | null
}

export interface DefaultReplyCompany {
  id: string
  closed?: boolean
}

/** The company id the reply should start on, or null for Personal. */
export function defaultReplyCompanyId(
  messages: readonly DefaultReplyMessage[] | null | undefined,
  companies: readonly DefaultReplyCompany[] | null | undefined,
): string | null {
  if (!messages || messages.length === 0 || !companies || companies.length === 0) return null

  let latest: DefaultReplyMessage | null = null
  let latestAt = Number.NEGATIVE_INFINITY
  for (const m of messages) {
    // only what the client (or a portal teammate) wrote counts; staff replies and automatic notices do not move the default
    if (m.sender_type !== 'client' || m.deleted_at) continue
    const at = Date.parse(m.created_at)
    if (Number.isNaN(at)) continue
    if (at >= latestAt) { latest = m; latestAt = at }
  }
  if (!latest) return null
  if (latest.sender_context !== 'company' || !latest.account_id) return null

  const company = companies.find(c => c.id === latest!.account_id)
  if (!company || company.closed) return null
  return company.id
}
