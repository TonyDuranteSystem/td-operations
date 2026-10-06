import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getUserDisplayName, isStaffUser } from '@/lib/auth'
import { postTeamMessage } from '@/lib/team/post-message'
import {
  FEEDBACK_CHANNEL_SLUG, FEEDBACK_PER_HOUR, formatFeedbackMessage, isFeedbackRejected, validateFeedback,
} from '@/lib/windows/tour-feedback'

/**
 * POST /api/team/windows-feedback — the "Something off, or an idea?" box of the floating-windows tour
 * (dev job f3f3e237). Staff only. Posts ONE message into the `td-windows-feedback` team channel, stamped
 * as written on behalf of the person who sent it.
 *
 * Why this route and not the normal team send route: that one starts the AI worker whenever a message
 * says "@claude" (a suggestion text can say that), pushes every device, and has no length / rate rules
 * for something a tour can send ten times. `postTeamMessage` never starts the worker; the text is also
 * defused (see lib/windows/tour-feedback.ts), so nothing a person types can mention or trigger anything.
 *
 * Plain, specific errors (R099): a missing channel says exactly what to create; a repeat or a flood says
 * to wait. The channel is never created silently — Antonio creates it (any staff member can).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const checked = validateFeedback(body)
  if (isFeedbackRejected(checked)) return NextResponse.json({ error: checked.error }, { status: 400 })

  const rawName = getUserDisplayName(user)
  const displayName = (typeof rawName === 'string' ? rawName : 'A team member').slice(0, 80)
  const message = formatFeedbackMessage(checked.value, displayName)

  // Find the channel first, so "not set up yet" is a clear answer and the checks below have a thread to look at.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any
  const { data: thread, error: threadError } = await admin
    .from('internal_threads')
    .select('id')
    .eq('thread_type', 'channel')
    .eq('channel_slug', FEEDBACK_CHANNEL_SLUG)
    .maybeSingle()
  if (threadError) {
    console.error('[windows-feedback] channel lookup failed', threadError.message)
    return NextResponse.json({ error: 'Could not reach the feedback channel just now. Please try again in a moment.' }, { status: 500 })
  }
  if (!thread) {
    return NextResponse.json(
      { error: `The feedback channel is not set up yet. Ask Antonio to create a Team Chat channel named "${FEEDBACK_CHANNEL_SLUG}".` },
      { status: 503 },
    )
  }

  // Same note twice in a couple of minutes = a double click or a retry after a lost answer: say it went through.
  const since2m = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const dup = await admin
    .from('internal_messages')
    .select('id')
    .eq('thread_id', thread.id)
    .eq('message', message)
    .gte('created_at', since2m)
    .limit(1)
  if (dup.error) {
    console.error('[windows-feedback] duplicate check failed', dup.error.message)
    return NextResponse.json({ error: 'Could not check your note just now. Please try again in a moment.' }, { status: 500 })
  }
  if (dup.data && dup.data.length > 0) return NextResponse.json({ ok: true, duplicate: true })

  // A person can only send so many an hour.
  const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const recent = await admin
    .from('internal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', thread.id)
    .eq('on_behalf_of_user_id', user.id)
    .gte('created_at', since1h)
  if (recent.error) {
    console.error('[windows-feedback] rate check failed', recent.error.message)
    return NextResponse.json({ error: 'Could not check your note just now. Please try again in a moment.' }, { status: 500 })
  }
  if ((recent.count ?? 0) >= FEEDBACK_PER_HOUR) {
    return NextResponse.json({ error: 'You have sent a lot of notes in the last hour. Please try again a little later.' }, { status: 429 })
  }

  try {
    await postTeamMessage({ channel: FEEDBACK_CHANNEL_SLUG, message, on_behalf_of: user.id })
  } catch (err) {
    // The reason goes to the server log, not to the browser (it can be database text).
    console.error('[windows-feedback] post failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not send your note. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
