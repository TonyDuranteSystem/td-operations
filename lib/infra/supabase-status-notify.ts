/**
 * Tells the team once when Supabase opens an incident that can hurt us, and once when it is over (Antonio, Luca and Jodi; Antonio 2 Nov 2026).
 * Pure orchestration with the database and the push injected, so it is unit-tested without either. "Once" is enforced by the store: `claimOpened` / `claimResolved`
 * answer true ONLY to the caller that wrote the row first, so two cron runs at the same moment cannot both announce it.
 */
import { openRelevantIncidents, recentlyResolvedRelevant, openedNotice, resolvedNotice, type FeedIncident, type SupabaseIncident } from '@/lib/infra/supabase-status'

/** Who is told. Matched by login email (case-insensitive). */
export const NOTICE_RECIPIENT_EMAILS: readonly string[] = ['antonio.durante@tonydurante.us', 'luca@tonydurante.us', 'jodi@tonydurante.us']

export interface NoticeStore {
  /** true when this call recorded "opened" for the incident (nobody had before). */
  claimOpened(i: SupabaseIncident): Promise<boolean>
  /** true when this call recorded "resolved" (we had announced it opened, and had not yet announced it over). */
  claimResolved(i: SupabaseIncident): Promise<boolean>
}

export interface NoticeResult { opened: string[]; resolved: string[]; sent: number }

/** An incident that ended more than a day ago is not worth announcing any more. */
const RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000

export async function runStatusNotices(args: {
  feed: readonly FeedIncident[]
  region: string
  now: number
  store: NoticeStore
  send: (n: { title: string; body: string; tag: string }) => Promise<number>
  dryRun?: boolean
}): Promise<NoticeResult> {
  const out: NoticeResult = { opened: [], resolved: [], sent: 0 }
  for (const i of openRelevantIncidents(args.feed, args.region)) {
    if (args.dryRun) { out.opened.push(i.id); continue }
    if (!(await args.store.claimOpened(i))) continue
    out.opened.push(i.id)
    out.sent += await args.send({ ...openedNotice(i), tag: `supabase-incident-${i.id}` })
  }
  for (const i of recentlyResolvedRelevant(args.feed, args.now, RESOLVED_WINDOW_MS, args.region)) {
    if (args.dryRun) { out.resolved.push(i.id); continue }
    if (!(await args.store.claimResolved(i))) continue
    out.resolved.push(i.id)
    out.sent += await args.send({ ...resolvedNotice(i), tag: `supabase-incident-${i.id}` })
  }
  return out
}
