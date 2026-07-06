import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { isAdmin } from '@/lib/auth'
import { listPackages } from '@/lib/td-communication/packages-queries'
import {
  getSiteForEnrollmentAsEditorState,
  getSiteById,
  createSite,
  saveDraft,
  setSlug,
  publishSite,
  unpublishSite,
  softDeleteSite,
  publicUrlForSlug,
  StaleEditError,
} from '@/lib/td-communication/client-landing-queries'
import { validateClientLandingContent } from '@/lib/td-communication/client-landing'
import type { ClandTheme, ClientLandingContent } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/** Load the enrollment and whether its package includes a landing page. */
async function loadEnrollmentGate(
  enrollmentId: string,
): Promise<{ exists: boolean; includesLanding: boolean; packageSlug: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('td_comm_enrollments')
    .select('id, package_slug')
    .eq('id', enrollmentId)
    .maybeSingle()
  if (!data) return { exists: false, includesLanding: false, packageSlug: null }
  let includesLanding = false
  if (data.package_slug) {
    try {
      const pkgs = await listPackages({ includeInactive: true })
      includesLanding = pkgs.some((p) => p.slug === data.package_slug && p.includes_landing)
    } catch {
      includesLanding = false
    }
  }
  return { exists: true, includesLanding, packageSlug: data.package_slug ?? null }
}

/**
 * GET — the editor state for this project's landing site (or null if none yet),
 * plus the gating flag (does the package include a landing page?) and whether the
 * caller is an admin (who can enable the builder anyway). Staff or scoped partner.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const gate = await loadEnrollmentGate(params.id)
    if (!gate.exists) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
    const state = await getSiteForEnrollmentAsEditorState(params.id)
    return NextResponse.json({
      state,
      includesLanding: gate.includesLanding,
      isAdmin: isAdmin(user),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load the landing page.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Load a site by id and assert it belongs to this enrollment (no cross-project write). */
async function ownedSite(enrollmentId: string, siteId: unknown) {
  if (typeof siteId !== 'string' || !siteId) return { error: 'siteId is required.', status: 400 as const }
  const site = await getSiteById(siteId)
  if (!site) return { error: 'Landing page not found.', status: 404 as const }
  if (site.enrollment_id !== enrollmentId) return { error: 'Not found.', status: 404 as const }
  return { site }
}

/**
 * POST — create | publish | unpublish. Create makes the first draft (optionally
 * theme-seeded); publish freezes the draft live; unpublish hides it.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = participant.name || participant.id

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = typeof body.action === 'string' ? body.action : ''

  try {
    if (action === 'create') {
      const gate = await loadEnrollmentGate(params.id)
      if (!gate.exists) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      // Gate: package must include a landing page, unless an admin overrides.
      if (!gate.includesLanding && !isAdmin(user)) {
        return NextResponse.json({ error: 'This package does not include a landing page.' }, { status: 403 })
      }
      const existing = await getSiteForEnrollmentAsEditorState(params.id)
      if (existing) return NextResponse.json({ state: existing }) // idempotent-ish: return the existing one
      const title = typeof body.title === 'string' ? body.title : ''
      const theme = body.theme && typeof body.theme === 'object' ? (body.theme as ClandTheme) : undefined
      const site = await createSite({ enrollmentId: params.id, title, actor, theme })
      return NextResponse.json({
        state: { site, hasUnpublishedChanges: true, publicUrl: publicUrlForSlug(site.slug) },
      })
    }

    const owned = await ownedSite(params.id, body.siteId)
    if ('error' in owned) return NextResponse.json({ error: owned.error }, { status: owned.status })

    if (action === 'publish') {
      const site = await publishSite({ id: owned.site.id, actor })
      return NextResponse.json({ state: { site, hasUnpublishedChanges: false, publicUrl: publicUrlForSlug(site.slug) } })
    }
    if (action === 'unpublish') {
      const site = await unpublishSite({ id: owned.site.id, actor })
      return NextResponse.json({ state: { site, hasUnpublishedChanges: true, publicUrl: publicUrlForSlug(site.slug) } })
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * PATCH — save (draft content) | rename (slug). Both carry expectedUpdatedAt for
 * optimistic concurrency; a stale token → 409 so the editor reconciles.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = participant.name || participant.id

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = typeof body.action === 'string' ? body.action : 'save'
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : ''
  if (!expectedUpdatedAt) return NextResponse.json({ error: 'expectedUpdatedAt is required.' }, { status: 400 })

  const owned = await ownedSite(params.id, body.siteId)
  if ('error' in owned) return NextResponse.json({ error: owned.error }, { status: owned.status })

  try {
    if (action === 'rename') {
      const slug = typeof body.slug === 'string' ? body.slug : ''
      const site = await setSlug({ id: owned.site.id, slug, expectedUpdatedAt })
      return NextResponse.json({ state: { site, hasUnpublishedChanges: JSON.stringify(site.content) !== JSON.stringify(site.published_content) || !site.published, publicUrl: publicUrlForSlug(site.slug) } })
    }
    // save
    const content = validateClientLandingContent(body.content as Partial<ClientLandingContent> | null)
    const site = await saveDraft({ id: owned.site.id, content, expectedUpdatedAt, actor })
    return NextResponse.json({ state: { site, hasUnpublishedChanges: !site.published || JSON.stringify(site.content) !== JSON.stringify(site.published_content), publicUrl: publicUrlForSlug(site.slug) } })
  } catch (err) {
    if (err instanceof StaleEditError) {
      return NextResponse.json({ error: err.message, code: 'STALE_EDIT' }, { status: 409 })
    }
    const message = err instanceof Error ? err.message : 'Could not save.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** DELETE — soft-delete the site (also removes copied public images). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = participant.name || participant.id

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const owned = await ownedSite(params.id, body.siteId)
  if ('error' in owned) return NextResponse.json({ error: owned.error }, { status: owned.status })

  try {
    await softDeleteSite({ id: owned.site.id, actor })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not delete.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
