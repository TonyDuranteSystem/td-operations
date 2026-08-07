/**
 * Partner access audit (dev job 5f534ed9, Antonio 2026-08-07): one row per
 * partner page load / data API call / private-file URL signing, viewable by
 * staff. Fire-and-forget by design — an audit write must NEVER break or slow
 * the partner surface it observes; failures are console-warned only.
 *
 * Surfaces logged: collab page load, project list, brief open, per-file
 * signed-URL grants (passports/SSNs — their own explicit rows), status
 * changes, chat reads/sends/uploads. Deliberately NOT logged: the unread
 * badge poll (continuous, no client data).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export type PartnerAccessSurface =
  | 'collab_page'
  | 'projects_list'
  | 'project_brief'
  | 'file_signed'
  | 'project_status_change'
  | 'chat_read'
  | 'chat_send'
  | 'chat_upload'

export interface PartnerAccessEvent {
  partnerId: string
  surface: PartnerAccessSurface
  method?: string
  path?: string
  /** For file_signed: the storage path of the granted file. */
  resource?: string
  detail?: Record<string, unknown>
  /** Pass the request when available so ip/user-agent are captured. */
  req?: Request
}

export function logPartnerAccess(event: PartnerAccessEvent): void {
  const ip = event.req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || event.req?.headers.get('x-real-ip') || null
  const userAgent = event.req?.headers.get('user-agent')?.slice(0, 400) || null
  // partner_access_log is absent from the generated DB types (regen blocked
  // by the schema-drift decision) — established cast precedent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (supabaseAdmin as any)
    .from('partner_access_log')
    .insert({
      partner_id: event.partnerId,
      surface: event.surface,
      method: event.method ?? null,
      path: event.path ?? null,
      resource: event.resource ?? null,
      detail: event.detail ?? {},
      ip,
      user_agent: userAgent,
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn('[partner-access-log] write failed:', error.message)
    })
}

/** Explicit per-file rows for signed-URL grants from the private wizard
 *  uploads bucket. One row per file — Antonio's requirement that document
 *  downloads never hide inside an aggregate count. */
export function logPartnerFileGrants(
  partnerId: string,
  enrollmentId: string,
  storagePaths: string[],
  req?: Request,
): void {
  for (const path of storagePaths) {
    logPartnerAccess({
      partnerId,
      surface: 'file_signed',
      resource: path,
      detail: { enrollment_id: enrollmentId },
      req,
    })
  }
}
