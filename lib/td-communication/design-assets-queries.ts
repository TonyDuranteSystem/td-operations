/**
 * TD Communication — design-assets data layer (Phase 12, server-side, service role).
 *
 * The ISOLATED save path for design-tool output. Deliberately does NOT reuse
 * `createDeliverable`: that helper auto-advances the enrollment to `concept_ready`
 * (arming the Phase 7 client disclaimer gate + logo reveal), which must NEVER
 * happen when Cris saves a throwaway mockup or an asset kit. This inserts the row
 * directly with NO status side-effect.
 *
 * Same access model as the rest of td-communication: RLS ON / no policy; the API
 * layer authorises the caller (resolveCommParticipant) before calling here.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { DesignAssetType } from './deliverables'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BUCKET = 'td-comm-deliverables'

export interface InsertDesignAssetInput {
  type: DesignAssetType
  /** Storage path within the enrollment's folder. */
  file_url: string
  file_name: string
  file_size?: number | null
  mime_type?: string | null
}

/**
 * Insert a design-asset deliverable row WITHOUT advancing the pipeline. Version
 * is max+1 within (enrollment, type) so mockups and kits each version cleanly;
 * concept_number is a fixed 1 (design assets are grouped by TYPE in the UI, not
 * by concept). is_draft=true, unreleased. Returns the new id.
 */
export async function insertDesignAsset(
  enrollmentId: string,
  input: InsertDesignAssetInput,
): Promise<{ id: string }> {
  const { data: existing } = await db
    .from('td_comm_deliverables')
    .select('version_number')
    .eq('enrollment_id', enrollmentId)
    .eq('type', input.type)
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
      type: input.type,
      file_url: input.file_url,
      file_name: input.file_name,
      file_size: input.file_size ?? null,
      mime_type: input.mime_type ?? null,
      concept_number: 1,
      version_number: maxVersion + 1,
      is_draft: true,
    })
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Could not save the design asset.')
  // NOTE: intentionally NO advanceStatus() — saving a design asset must never
  // move the project into concept_ready / trigger the client reveal.
  return { id: data.id as string }
}

export interface LogoSource {
  file_url: string
  file_name: string
  mime_type: string | null
}

/**
 * Resolve an image deliverable's storage path FOR the byte passthrough — scoped
 * to the enrollment (ownership check → no IDOR: a deliverableId from another
 * project returns null). Only non-deleted rows with a stored path.
 */
export async function getDeliverableLogoSource(
  enrollmentId: string,
  deliverableId: string,
): Promise<LogoSource | null> {
  const { data, error } = await db
    .from('td_comm_deliverables')
    .select('file_url, file_name, mime_type')
    .eq('id', deliverableId)
    .eq('enrollment_id', enrollmentId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.file_url) return null
  return {
    file_url: data.file_url as string,
    file_name: (data.file_name as string) ?? 'logo',
    mime_type: (data.mime_type as string | null) ?? null,
  }
}

/** Download the raw bytes of a deliverable path from the private bucket. */
export async function downloadDeliverableBytes(
  path: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path)
  if (error || !data) return null
  const bytes = Buffer.from(await data.arrayBuffer())
  return { bytes, contentType: data.type || 'application/octet-stream' }
}
