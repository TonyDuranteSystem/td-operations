import { NextRequest, NextResponse } from 'next/server'
import { processClaudeReply } from '@/lib/team/claude-trigger'

// Long-running worker call (research rails). Give it room under Vercel's ceiling.
export const maxDuration = 300

/**
 * POST /api/team/claude/process
 * Internal endpoint fired by triggerClaudeReply. Runs the shared AI worker for a
 * team @claude mention and rewrites the placeholder message with the answer.
 * Authenticated by the CRON_SECRET bearer (server-to-server only).
 * Body: { thread_id, prompt_message_id, placeholder_id, sender_is_antonio }
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const threadId: string | null = body.thread_id || null
  const promptMessageId: string | null = body.prompt_message_id || null
  const placeholderId: string | null = body.placeholder_id || null
  const senderIsAntonio = !!body.sender_is_antonio

  if (!threadId || !promptMessageId || !placeholderId) {
    return NextResponse.json({ error: 'thread_id, prompt_message_id, placeholder_id required' }, { status: 400 })
  }

  const result = await processClaudeReply({ threadId, promptMessageId, placeholderId, senderIsAntonio })
  return NextResponse.json(result)
}
