/**
 * Gmail label helpers — used to file system-generated emails under a label
 * (shown as a folder in Gmail) so they stop cluttering searches.
 *
 * Why labels and not filters: the service account's Gmail scopes are
 * readonly/compose/modify (lib/gmail.ts) — creating filters needs
 * gmail.settings.basic, which we deliberately don't have. Filters also only
 * run on INCOMING mail, so they could never touch our own sent copies.
 * Labeling the message right after send is the only mechanism that works.
 */

import { gmailGet, gmailPost } from '@/lib/gmail'

/** Label for the client-facing portal chat notification emails
 * ("New message from the Tony Durante team" / Italian equivalent). */
export const PORTAL_CHAT_LABEL = 'Portal chat notifications'

interface GmailLabelRow {
  id: string
  name: string
  type: 'system' | 'user'
}

// Cache per (user, label name) — label ids are stable for a mailbox's lifetime.
const labelIdCache = new Map<string, string>()

/**
 * Resolve a user label's id by name, creating the label if it doesn't exist.
 * Case-insensitive name match (Gmail rejects duplicate names ignoring case).
 */
export async function getOrCreateLabelId(
  name: string,
  asUser?: string,
): Promise<string> {
  const cacheKey = `${asUser ?? 'default'}::${name.toLowerCase()}`
  const cached = labelIdCache.get(cacheKey)
  if (cached) return cached

  const listed = (await gmailGet('/labels', undefined, asUser)) as {
    labels?: GmailLabelRow[]
  }
  const existing = (listed.labels ?? []).find(
    (l) => l.name.toLowerCase() === name.toLowerCase(),
  )
  if (existing) {
    labelIdCache.set(cacheKey, existing.id)
    return existing.id
  }

  const created = (await gmailPost(
    '/labels',
    {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
    asUser,
  )) as GmailLabelRow
  labelIdCache.set(cacheKey, created.id)
  return created.id
}

/** Add a label to one message (messages.modify). */
export async function addLabelToMessage(
  messageId: string,
  labelId: string,
  asUser?: string,
): Promise<void> {
  await gmailPost(
    `/messages/${messageId}/modify`,
    { addLabelIds: [labelId] },
    asUser,
  )
}

/**
 * File a just-sent portal chat notification under PORTAL_CHAT_LABEL.
 * Never throws — labeling is cosmetic and must not fail the send path.
 * No-ops when messageId is missing (e.g. sandbox mode returns no id).
 */
export async function labelPortalChatNotification(
  messageId: string | undefined | null,
  asUser?: string,
): Promise<void> {
  if (!messageId) return
  try {
    const labelId = await getOrCreateLabelId(PORTAL_CHAT_LABEL, asUser)
    await addLabelToMessage(messageId, labelId, asUser)
  } catch (err) {
    console.error('[gmail-labels] Failed to label portal chat notification:', err)
  }
}
