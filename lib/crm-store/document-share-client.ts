/**
 * Browser-side helpers shared by every staff "eye" (storage browser now; contact page and file manager later):
 * fetch who a message can go to, and send the chosen message through the normal staff chat route
 * (POST /api/portal/chat — so the scope check, the "is this one of that person's companies" check, the portal
 * notification and the email throttle all apply exactly as for any staff send).
 */
import type { ShareContext, ShareTarget } from '@/lib/portal/document-share-text'

/** Where the file comes from: a CRM Store file, a CRM documents row, or only a company (an unprocessed Drive file). */
export type ShareSource = 'store' | 'document' | 'account'

export async function fetchShareContext(id: string, source: ShareSource = 'store'): Promise<ShareContext> {
  const url = source === 'store' ? `/api/crm-store/browse/file/${id}/share-context`
    : source === 'document' ? `/api/documents/share-context?documentId=${encodeURIComponent(id)}`
    : `/api/documents/share-context?accountId=${encodeURIComponent(id)}`
  const res = await fetch(url, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not work out who the message can go to — please try again.')
  return data as ShareContext
}

export interface ShareMessageToSend {
  target: ShareTarget
  topic: string
  message: string
  addressedToMemberId: string | null
  addressedToCompany: boolean
}

/** Pure: the exact body sent to POST /api/portal/chat. A company send declares company scope and carries NO contact id. */
export function buildShareChatBody(m: ShareMessageToSend): Record<string, unknown> {
  if (m.target.kind === 'company') {
    return {
      account_id: m.target.accountId,
      sender_context: 'company',
      topic: m.topic,
      message: m.message,
      ...(m.addressedToCompany ? { addressed_to_company: true } : {}),
      ...(m.addressedToMemberId ? { addressed_to_member_id: m.addressedToMemberId } : {}),
    }
  }
  return { contact_id: m.target.contactId, sender_context: 'person', topic: m.topic, message: m.message }
}

export async function sendShareMessage(m: ShareMessageToSend): Promise<void> {
  const res = await fetch('/api/portal/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildShareChatBody(m)) })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error((d as { error?: string }).error || 'The message could not be sent — please try again.')
  }
}
