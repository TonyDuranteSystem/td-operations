import { getContactActivity, type ActivityEvent, type ActivityEventType } from '@/lib/operations/account-activity'

// Event types visible to clients — excludes internal CRM events (tasks, actions) and
// portal_messages (already shown in the chat thread) and documents (admin uploads).
const PORTAL_VISIBLE = new Set<ActivityEventType>(['offer', 'payment', 'service', 'wizard'] as ActivityEventType[])

export async function getPortalJourneyEvents(
  contactId: string,
  accountIds: string[],
): Promise<ActivityEvent[]> {
  const all = await getContactActivity(contactId, { accountIds, limit: 500 })
  return all.filter(e => PORTAL_VISIBLE.has(e.type))
}
