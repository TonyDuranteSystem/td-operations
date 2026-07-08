import { NextRequest, NextResponse } from 'next/server'
import { processClaudeReply, rescueStuckClaudeReplies } from '@/lib/team/claude-trigger'

// Long-running worker call (research rails). Give it room under Vercel's ceiling.
export const maxDuration = 300

/**
 * /api/team/claude/process — the @claude worker runner for Team Chat.
 *
 * Two modes, both CRON_SECRET-authed (server-to-server only):
 *  - DIRECT (POST with thread/prompt/placeholder ids): fired by
 *    triggerClaudeReply right after a human @claude mention.
 *  - SCAN (GET, or POST without ids): the cron safety net — rescues "…"
 *    placeholders whose direct fire was lost (registered in vercel.json,
 *    same pattern as the Slack worker cron).
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
  const threadId: string | null = body.thread_id || null
  const promptMessageId: string | null = body.prompt_message_id || null
  const placeholderId: string | null = body.placeholder_id || null

  // Scan mode: cron GET, or a POST without the direct-mode ids.
  if (!threadId || !promptMessageId || !placeholderId) {
    const result = await rescueStuckClaudeReplies()
    return NextResponse.json({ mode: 'scan', ...result })
  }

  const senderIsAntonio = !!body.sender_is_antonio
  const result = await processClaudeReply({ threadId, promptMessageId, placeholderId, senderIsAntonio })
  return NextResponse.json({ mode: 'direct', ...result })
}

export async function GET(request: NextRequest) { return handle(request) }
export async function POST(request: NextRequest) { return handle(request) }
