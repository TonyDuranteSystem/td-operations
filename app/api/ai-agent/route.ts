import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin, isClient } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/ai-agent
 * AI agent for dashboard users — Claude (primary) + GPT-4o (fallback).
 * Admin always has access. Team members require ai_agent.enabled_for_team = true in app_settings.
 * Body: { messages: [{ role: 'user'|'assistant', content: string }] }
 * Returns: { content: string, provider: string, tools_used: string[] }
 */
export async function POST(request: NextRequest) {
  // Rate limit: 20 requests per minute
  const rl = checkRateLimit(getRateLimitKey(request) + ':ai-agent', 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 10) } }
    )
  }

  // Auth check: admin always allowed, team allowed if toggle is on, clients never
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || isClient(user)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  if (!isAdmin(user)) {
    // Team member — check if AI agent is enabled for team
    const { data: aiSetting } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_agent')
      .single()
    if (!aiSetting?.value?.enabled_for_team) {
      return NextResponse.json({ error: 'AI Agent is not enabled for team members. Ask your admin to enable it in Team Management.' }, { status: 403 })
    }
  }

  try {
    const { messages, provider: requestedProvider } = await request.json()

    if (!messages?.length || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'messages array required' }, { status: 400 })
    }

    // Validate and trim messages
    const validMessages = messages
      .filter((m: { role?: string; content?: string }) =>
        (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      )
      .map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.slice(0, 10000),
      }))
      .slice(-20) // Keep last 20 messages for context

    if (validMessages.length === 0) {
      return NextResponse.json({ error: 'No valid messages provided' }, { status: 400 })
    }

    // Validate provider choice
    const forcedProvider = ['claude', 'openai'].includes(requestedProvider) ? requestedProvider : undefined

    // Lazy import to avoid loading providers at build time
    const { callAgent } = await import('@/lib/ai-agent/providers')
    const result = await callAgent(validMessages, forcedProvider)

    return NextResponse.json({
      content: result.reply,
      provider: result.provider,
      tools_used: result.toolsUsed,
    })
  } catch (err) {
    console.error('[ai-agent] Error:', err)
    const message = err instanceof Error ? err.message : 'Agent failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// 60s timeout for Vercel Pro (tool loops can be slow)
export const maxDuration = 60
