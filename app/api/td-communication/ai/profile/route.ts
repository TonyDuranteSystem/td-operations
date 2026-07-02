import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { callAI } from '@/lib/portal/ai-provider'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { getEnrollment, saveBrandProfile } from '@/lib/td-communication/pipeline-queries'
import { groupBrief } from '@/lib/td-communication/pipeline'
import { buildProfilePrompt, parseProfileResponse, hasBriefContent } from '@/lib/td-communication/brand-profile'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/td-communication/ai/profile
 * Synthesize (or return the cached) AI Brand Profile for one enrollment's brief.
 * Staff OR scoped partner (Cris) — same access model as the projects routes.
 * Body: { enrollmentId, regenerate? }.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const settings = await getCommSettings()
  if (!settings.ai_enabled) {
    return NextResponse.json({ error: 'AI features are temporarily disabled.' }, { status: 503 })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'AI is not configured.' }, { status: 503 })
  }

  let body: { enrollmentId?: unknown; regenerate?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const enrollmentId = typeof body.enrollmentId === 'string' ? body.enrollmentId : ''
  const regenerate = body.regenerate === true
  if (!enrollmentId) {
    return NextResponse.json({ error: 'enrollmentId is required.' }, { status: 400 })
  }

  try {
    const project = await getEnrollment(enrollmentId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
    }

    // Cache-first unless the caller forces a regenerate.
    if (project.ai_brand_profile && !regenerate) {
      return NextResponse.json({ profile: project.ai_brand_profile, cached: true })
    }

    const sections = groupBrief(project.form_data).sections
    if (!hasBriefContent(sections)) {
      return NextResponse.json({ error: 'This project has no brand answers yet.' }, { status: 400 })
    }

    const { systemPrompt, userPrompt } = buildProfilePrompt(sections)
    const result = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 700,
      temperature: 0.6,
      timeoutMs: 45_000,
    })

    const profile = parseProfileResponse(result.text)
    if (!profile) {
      return NextResponse.json(
        { error: 'The AI returned an unexpected format. Please try again.' },
        { status: 502 },
      )
    }

    const cached = await saveBrandProfile(enrollmentId, profile, result.model)
    return NextResponse.json({ profile: cached, cached: false })
  } catch (err) {
    console.error('[td-comm ai/profile] error:', err)
    const message = err instanceof Error ? err.message : 'Failed to generate the brand profile.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
