import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveLandingAccess } from '@/lib/td-communication/admin-auth'
import {
  getLandingEditorState,
  getPublishedLanding,
  listLandingPackages,
  saveDraft,
  publishDraft,
  discardDraft,
} from '@/lib/td-communication/landing'
import type { LandingContent } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/landing — landing page content.
 *
 * PUBLIC route (in middleware PUBLIC_PREFIXES). Behavior depends on the caller:
 *   - staff / scoped partner (editor) → full editor state { draft, published,
 *     hasUnpublishedChanges, meta } + packages + canEdit.
 *   - anyone else (public)            → { content: published, packages } only —
 *     the draft is NEVER exposed publicly.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = user ? await resolveLandingAccess(user) : null

  try {
    const packages = await listLandingPackages()
    if (access) {
      const state = await getLandingEditorState()
      return NextResponse.json({ ...state, packages, canEdit: access.canEdit })
    }
    const content = await getPublishedLanding()
    return NextResponse.json({ content, packages })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load landing content.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Shared write-gate: 401/403 response, or the editor identity to act as. */
async function gateWrite(user: Parameters<typeof resolveLandingAccess>[0]) {
  const access = await resolveLandingAccess(user)
  if (!access) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!access.canEdit) {
    return { error: NextResponse.json({ error: 'You do not have permission to edit the landing page.' }, { status: 403 }) }
  }
  return { name: access.participant.name }
}

/** PATCH — save the draft (autosave / Save draft). Body = draft content. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await gateWrite(user)
  if ('error' in gate) return gate.error

  let body: Partial<LandingContent>
  try {
    body = (await req.json()) as Partial<LandingContent>
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  try {
    const state = await saveDraft(body, gate.name)
    return NextResponse.json({ ...state, canEdit: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save draft.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** POST — publish: promote the draft to the live (published) content. */
export async function POST(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await gateWrite(user)
  if ('error' in gate) return gate.error

  try {
    const state = await publishDraft(gate.name)
    return NextResponse.json({ ...state, canEdit: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to publish.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** DELETE — discard unpublished changes (revert draft to published). */
export async function DELETE(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await gateWrite(user)
  if ('error' in gate) return gate.error

  try {
    const state = await discardDraft(gate.name)
    return NextResponse.json({ ...state, canEdit: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to discard changes.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
