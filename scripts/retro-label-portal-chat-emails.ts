/**
 * One-off: file all previously-sent portal chat notification emails under the
 * "Portal chat notifications" Gmail label (shown as a folder in Gmail).
 *
 * Going forward, notifyClientOfAdminMessage labels each send at send time
 * (lib/portal/notifications.ts → lib/gmail-labels.ts). This script covers the
 * backlog that predates that change.
 *
 * Idempotent: adding a label a message already has is a no-op in Gmail.
 * Read-safe: only ADDS a label — never archives, deletes, or marks anything.
 *
 * Run:  npx tsx scripts/retro-label-portal-chat-emails.ts          (dry run)
 *       npx tsx scripts/retro-label-portal-chat-emails.ts --apply  (label them)
 * Needs GOOGLE_SA_KEY in the environment (same credential the app uses).
 */

import { gmailGet, gmailPost } from '../lib/gmail'
import { getOrCreateLabelId, PORTAL_CHAT_LABEL } from '../lib/gmail-labels'

// Exact subjects produced by notifyClientOfAdminMessage (EN + IT).
const QUERY = [
  'from:support@tonydurante.us',
  '(subject:"New message from the Tony Durante team" OR subject:"Nuovo messaggio dal team Tony Durante")',
].join(' ')

const BATCH_SIZE = 1000 // Gmail batchModify hard limit

async function listAllMessageIds(): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const params: Record<string, string> = { q: QUERY, maxResults: '500' }
    if (pageToken) params.pageToken = pageToken
    const page = (await gmailGet('/messages', params)) as {
      messages?: { id: string }[]
      nextPageToken?: string
    }
    for (const m of page.messages ?? []) ids.push(m.id)
    pageToken = page.nextPageToken
  } while (pageToken)
  return ids
}

async function main() {
  const apply = process.argv.includes('--apply')
  console.warn(`Searching: ${QUERY}`)
  const ids = await listAllMessageIds()
  console.warn(`Found ${ids.length} matching messages.`)

  if (!apply) {
    console.warn('Dry run — re-run with --apply to label them.')
    return
  }

  const labelId = await getOrCreateLabelId(PORTAL_CHAT_LABEL)
  console.warn(`Label "${PORTAL_CHAT_LABEL}" id: ${labelId}`)

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    await gmailPost('/messages/batchModify', {
      ids: batch,
      addLabelIds: [labelId],
    })
    console.warn(`Labeled ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}`)
  }
  console.warn('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
