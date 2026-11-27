// "How many people see this message" for the staff Portal Chats notice (dev job 8d077f3b).
// Two sources can count the people of a company: the linked contacts (account_contacts, a thin copy) and the real roster (members). They
// disagree for some companies, and the notice must never say less than the roster does, so the LARGER of the two is the number of members.
// Portal teammates (a client's own staff with the chat permission) are added on top.

export interface AudienceCounts {
  contact_count?: number | null
  member_count?: number | null
  chat_teammate_count?: number | null
}

export interface AudienceHeadCount {
  members: number
  teammates: number
  total: number
}

function whole(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function audienceHeadCount(counts: AudienceCounts | null | undefined): AudienceHeadCount {
  const members = Math.max(whole(counts?.contact_count), whole(counts?.member_count))
  const teammates = whole(counts?.chat_teammate_count)
  return { members, teammates, total: members + teammates }
}

export interface AudienceNoticeInput {
  /** the chosen company is closed, so nothing can be sent there and no warning is needed */
  closed: boolean
  /** a company is the send target (a company chat, or a company picked in a person's chat) */
  hasTarget: boolean
  /** members + portal teammates, from audienceHeadCount */
  total: number
  /** the thread's own member list (linked contacts) */
  threadMembers: number
  /** the real roster options of an "Addressed to" picker */
  addressedToOptions: number
}

/**
 * Whether the "who else reads this" notice is shown (the yellow card on the website, the Before-you-send pop-up line in the app). One rule for
 * both, so the warning can never show in one place and be missing in the other.
 */
export function shouldShowAudienceNotice(i: AudienceNoticeInput): boolean {
  return !i.closed && i.hasTarget && (i.total > 1 || i.threadMembers > 1 || i.addressedToOptions > 1)
}
