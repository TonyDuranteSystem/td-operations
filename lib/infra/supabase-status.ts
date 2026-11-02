/**
 * Supabase incidents, as our staff should see them (Antonio, 2 Nov 2026: a Supabase storage outage looked like a Luca-side problem for an hour and a half;
 * "I want the message to say that the issue is in Supabase, so we know"). Pure rules over the public status feed (`status.supabase.com/api/v2/incidents.json`):
 * which open incident can hurt US, what it says, whether it is about uploads. The fetching is in `supabase-status-server.ts`.
 */

export interface FeedUpdate { status: string; body: string; created_at: string }
export interface FeedIncident { id: string; name: string; status: string; created_at: string; resolved_at?: string | null; incident_updates?: FeedUpdate[] }

/** What a person is shown: Supabase's own words, never paraphrased. */
export interface SupabaseIncident {
  id: string
  title: string
  status: string
  since: string
  resolvedAt: string | null
  latestUpdate: string
  latestUpdateAt: string
  /** Storage is involved: file uploads / downloads may fail. */
  affectsUploads: boolean
}

/** The region our project runs in. Set SUPABASE_REGION to change it; until somebody confirms it in the Supabase dashboard this is the region the 2 Nov outage named. */
export const DEFAULT_SUPABASE_REGION = 'us-east-1'

/** Incidents about Supabase's own tooling (not our data or our files) never matter to staff. */
const IRRELEVANT = /\b(logs?|log drains?|dashboard|support|management api|mgmt api|billing|project (creation|lifecycle)|lifecycle operation|marketplace|status page|documentation|docs)\b/i
/** Incidents about the services our app stands on. */
const RELEVANT = /\b(storage|database|postgres|auth|authentication|realtime|rest api|postgrest|api gateway|connection|pooler|edge functions?|read replica|upload)\b/i
const REGION_CODE = /\b[a-z]{2}-[a-z]+-\d\b/gi
const STORAGE = /\b(storage|upload)/i

/** Open means Supabase has not said "resolved" (or "postmortem" — also finished). */
export function isOpen(i: Pick<FeedIncident, 'status'>): boolean {
  const s = (i.status ?? '').toLowerCase()
  return s !== 'resolved' && s !== 'postmortem' && s !== 'completed'
}

/** Does this incident name a region other than ours? "multiple regions" / "all regions" / no region at all count as ours. */
export function mentionsOtherRegion(title: string, region: string): boolean {
  const codes = (title.match(REGION_CODE) ?? []).map(c => c.toLowerCase())
  return codes.length > 0 && !codes.includes(region.toLowerCase())
}

export function isRelevantToUs(i: Pick<FeedIncident, 'name'>, region: string = DEFAULT_SUPABASE_REGION): boolean {
  const name = i.name ?? ''
  // tooling incidents (logs, dashboard, support, project creation…) never matter unless the title also names a service we stand on
  if (!RELEVANT.test(name)) return false
  if (IRRELEVANT.test(name) && !/\b(storage|database|postgres|auth|realtime|upload)\b/i.test(name)) return false
  return !mentionsOtherRegion(name, region)
}

export function toIncident(i: FeedIncident): SupabaseIncident {
  const updates = [...(i.incident_updates ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const latest = updates[0]
  return {
    id: i.id,
    title: i.name,
    status: i.status,
    since: i.created_at,
    resolvedAt: i.resolved_at ?? null,
    latestUpdate: (latest?.body ?? '').trim(),
    latestUpdateAt: latest?.created_at ?? i.created_at,
    affectsUploads: STORAGE.test(i.name),
  }
}

/** The open incidents that can hurt us, newest first. */
export function openRelevantIncidents(feed: readonly FeedIncident[], region: string = DEFAULT_SUPABASE_REGION): SupabaseIncident[] {
  return feed.filter(i => isOpen(i) && isRelevantToUs(i, region)).map(toIncident).sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
}

/** Incidents that can hurt us and ended within `withinMs` (to tell the team "it is over"). */
export function recentlyResolvedRelevant(feed: readonly FeedIncident[], now: number, withinMs: number, region: string = DEFAULT_SUPABASE_REGION): SupabaseIncident[] {
  return feed
    .filter(i => !isOpen(i) && isRelevantToUs(i, region))
    .map(toIncident)
    .filter(i => i.resolvedAt && now - Date.parse(i.resolvedAt) <= withinMs && now >= Date.parse(i.resolvedAt))
}

/** "21:34 UTC" — the time in Supabase's own clock; staff are in different time zones, so the zone is always written. */
export function utcClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

/** The message staff read, in the bar and in the notification. Names Supabase, quotes its title and its latest update. */
export function staffMessage(i: SupabaseIncident): string {
  const since = utcClock(i.since)
  const upd = i.latestUpdate ? ` Latest update (${utcClock(i.latestUpdateAt)}): ${i.latestUpdate}` : ''
  const effect = i.affectsUploads ? ' Files may not save. This is not your connection.' : ' Some things may not work. This is not your connection.'
  return `Supabase reports an incident: “${i.title}”${since ? ` (since ${since})` : ''}.${upd}${effect}`
}

/** What clients see: never the cause. */
export const CLIENT_UPLOAD_MESSAGE = 'Uploads are temporarily unavailable, please try again shortly.'

/** One short line for the places that fail (the chat's waiting note, the workspace upload error). */
export function failureHint(i: Pick<SupabaseIncident, 'title' | 'affectsUploads'>): string | null {
  if (!i.affectsUploads) return null
  return `Supabase has an open storage incident (“${i.title}”). Your file did not save because of it, not because of your connection. It will work again once Supabase clears it.`
}

/** The notification sent when an incident opens / clears. */
export function openedNotice(i: SupabaseIncident): { title: string; body: string } {
  return { title: 'Supabase incident', body: staffMessage(i) }
}
export function resolvedNotice(i: SupabaseIncident): { title: string; body: string } {
  return { title: 'Supabase incident resolved', body: `Supabase says it is resolved: “${i.title}”${i.resolvedAt ? ` (${utcClock(i.resolvedAt)})` : ''}. ${i.latestUpdate}`.trim() }
}
