import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the old workspace Home (dev job 9aec66fa). It was the owner's page and belongs in his own CRM Marketing section (Antonio, 28 Oct 2026: the owner and Rocco are different people).
 * Old bookmarks and the old tour end up on the person's real first screen.
 */
export default function MarketingHome() {
  redirect('/marketing')
}
