/**
 * TD Communication — Social Sharing Kit data layer (Phase 15, server-side, service role).
 *
 * The CLIENT-FACING sibling of the Phase 12 `design-assets-queries.ts` isolated
 * path. Like that path it deliberately does NOT call `advanceStatus` — releasing
 * a social kit must NEVER move the project into `concept_ready` / arm the Phase 7
 * reveal. It differs from the Phase 12 save in one way: the row is stamped
 * `released_at` at insert (is_draft=false), because the whole point is to make the
 * kit downloadable by the client.
 *
 * Same access model as the rest of td-communication: RLS ON / no policy; the API
 * layer authorises the caller before calling here. The private `td-comm-deliverables`
 * bucket is reused; the client only ever receives a short-lived signed FORCED-
 * DOWNLOAD url (never the storage path).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BUCKET = 'td-comm-deliverables'
const SIGNED_URL_TTL = 60 * 60 * 6 // 6 hours, mirrors deliverables-queries

const SOCIAL_KIT_TYPE = 'social_kit' as const

export interface InsertSocialKitInput {
  /** Storage path within the enrollment's folder (guarded by the route). */
  file_url: string
  file_name: string
  file_size?: number | null
  mime_type?: string | null
}

/**
 * Insert a RELEASED social-kit deliverable WITHOUT advancing the pipeline.
 * Version is max+1 within (enrollment, 'social_kit'); concept_number is a fixed 1.
 * is_draft=false and released_at is stamped now, so it is immediately client-
 * downloadable (gated in the portal by status='delivered' + the kill-switch).
 * Returns the new id.
 */
export async function insertClientSocialKit(
  enrollmentId: string,
  input: InsertSocialKitInput,
  actor: string,
): Promise<{ id: string }> {
  const { data: existing } = await db
    .from('td_comm_deliverables')
    .select('version_number')
    .eq('enrollment_id', enrollmentId)
    .eq('type', SOCIAL_KIT_TYPE)
    .is('deleted_at', null)
  let maxVersion = 0
  for (const r of (existing ?? []) as { version_number: number }[]) {
    const n = Number(r.version_number)
    if (Number.isFinite(n) && n > maxVersion) maxVersion = n
  }

  const { data, error } = await db
    .from('td_comm_deliverables')
    .insert({
      enrollment_id: enrollmentId,
      type: SOCIAL_KIT_TYPE,
      file_url: input.file_url,
      file_name: input.file_name,
      file_size: input.file_size ?? null,
      mime_type: input.mime_type ?? null,
      concept_number: 1,
      version_number: maxVersion + 1,
      is_draft: false,
      released_at: new Date().toISOString(),
      released_by: actor,
    })
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Could not save the social sharing kit.')
  // NOTE: intentionally NO advanceStatus() — releasing a social kit must never
  // move the project into concept_ready / trigger the client reveal.
  return { id: data.id as string }
}

export interface ReleasedSocialKit {
  id: string
  file_name: string
  file_size: number | null
  created_at: string
  released_at: string | null
  /** Signed, short-lived, forced-attachment download URL. */
  download_url: string | null
}

/**
 * Released social kits for one enrollment, newest first, each with a signed
 * forced-download URL. Returns [] when none are released. Used by BOTH the staff
 * view and (via the client route) the portal download.
 */
export async function listReleasedSocialKits(enrollmentId: string): Promise<ReleasedSocialKit[]> {
  const { data, error } = await db
    .from('td_comm_deliverables')
    .select('id, file_url, file_name, file_size, created_at, released_at')
    .eq('enrollment_id', enrollmentId)
    .eq('type', SOCIAL_KIT_TYPE)
    .not('released_at', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as {
    id: string
    file_url: string | null
    file_name: string
    file_size: number | null
    created_at: string
    released_at: string | null
  }[]

  return Promise.all(
    rows.map(async (r) => {
      let download_url: string | null = null
      if (r.file_url) {
        const { data: dl } = await supabaseAdmin.storage
          .from(BUCKET)
          .createSignedUrl(r.file_url, SIGNED_URL_TTL, { download: r.file_name || true })
        if (dl?.signedUrl) download_url = dl.signedUrl
      }
      return {
        id: r.id,
        file_name: r.file_name,
        file_size: r.file_size ?? null,
        created_at: r.created_at,
        released_at: r.released_at ?? null,
        download_url,
      }
    }),
  )
}
