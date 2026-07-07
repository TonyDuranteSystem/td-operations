import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { validateNarrative, renderCallForOffer } from '@/lib/offer-narrative'
import { callAI } from '@/lib/portal/ai-provider'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { reportSystemError } from '@/lib/system-errors'

// A rich ~4096-token Sonnet narrative runs well past the default function
// window; give it room (proven value already used elsewhere in this codebase)
// so the request isn't killed mid-generation.
export const maxDuration = 300

/**
 * Fetch the most recent call's notes + full transcript for this lead/account
 * from call_summaries, rendered as a context block for the offer-narrative AI.
 * This is what turns a thin "summary" into a genuinely personalized narrative —
 * the model gets what the client actually said, not just the capped notes the
 * dialog pasted in. Best-effort: returns '' on no call / any error so the
 * generator cleanly falls back to notes-only.
 */
async function fetchCallContext(leadId?: string | null, accountId?: string | null): Promise<string> {
  if (!leadId && !accountId) return ''
  try {
    let query = supabaseAdmin
      .from('call_summaries')
      .select('meeting_name, created_at, notes, transcript')
      .order('created_at', { ascending: false })
      .limit(1)
    // Prefer the lead's call; fall back to the account's.
    query = leadId ? query.eq('lead_id', leadId) : query.eq('account_id', accountId as string)
    const { data, error } = await query.maybeSingle()
    if (error || !data) return ''
    return renderCallForOffer(data)
  } catch (err) {
    console.error('[generate-offer-narrative] call-context fetch failed (non-fatal):', err instanceof Error ? err.message : err)
    return ''
  }
}

// ── System prompt ──

function buildSystemPrompt(language: 'en' | 'it'): string {
  // Single-language intro — match the client's preferred language only.
  // 2026-05-07: previously generated BOTH intros; the access-code offer page
  // renders both fields side-by-side, which produced unwanted bilingual
  // welcome blocks for monolingual clients (Mojo / Sanjin case). Generator
  // now produces only the matching intro and leaves the other empty.
  const introSpec = language === 'it'
    ? `- "intro_it": A rich, 4-6 sentence personalized introduction in NATURAL Italian (not machine-translated). Open by referencing what the client actually shared on their call — their business, their goal, a specific concern or opportunity they raised. Then explain what this offer is designed to do for them and why this approach fits their situation. Make it personal and specific to THIS client, never generic.
- "intro_en": MUST be an empty string "". Do not produce English intro content.`
    : `- "intro_en": A rich, 4-6 sentence personalized introduction in English. Open by referencing what the client actually shared on their call — their business, their goal, a specific concern or opportunity they raised. Then explain what this offer is designed to do for them and why this approach fits their situation. Make it personal and specific to THIS client, never generic.
- "intro_it": MUST be an empty string "". Do not produce Italian intro content.`

  const otherSectionsLang = language === 'it' ? 'Italian' : 'English'

  return `You are a senior business consultant at Tony Durante LLC, a professional consulting firm based in Florida that helps international entrepreneurs set up and manage U.S. LLCs.

Your job is to write a rich, professional, client-facing offer narrative — NOT a terse summary. The client reads this before signing, so it should feel like a tailored strategy memo from a consultant who listened carefully to their call and understands their situation deeply.

Your writing style is:
- Professional but warm and approachable — a trusted advisor, not a salesperson
- Specific: pull real details from the call/notes (business model, country, goals, concerns raised). Every sentence should be about THIS client, not a template
- Confident and authoritative about the services
- No filler, no jargon

You must produce ALL output as a single JSON object with exactly these keys:
${introSpec}
- "strategy": An array of 4-5 strategic steps. Each: { "step_number": N, "title": "Short Title", "description": "2-3 sentence explanation of WHY this step matters for this client specifically, grounded in their situation — not just what it is" }. These describe the overall approach/plan for the client.
- "next_steps": An array of 4-5 next steps after signing. Each: { "step_number": N, "title": "Short Title", "description": "2-3 sentences: what happens, who does what, and what the client can expect" }. These describe what happens operationally after the client signs.
- "future_developments": An array of 3-4 items. Each: { "text": "A concrete future opportunity specific to their business model or goals, 1-2 sentences" }. These are growth opportunities for later.
- "immediate_actions": An array of 2-3 items. Each: { "title": "Action Name", "description": "2-3 sentences: what needs to happen right away and why it matters for this client" }. These are things to address right away.

LANGUAGE RULES (CRITICAL):
- The client's preferred language is ${otherSectionsLang}. Generate ALL content in ${otherSectionsLang} only.
- The intro field for the OTHER language MUST be an empty string ""; do NOT translate or duplicate the intro into the other language.
- "strategy", "next_steps", "future_developments", and "immediate_actions" MUST be written in ${otherSectionsLang}.

CONTRACT TYPE RULES (CRITICAL — shapes the entire content):
- "formation": client is forming a BRAND NEW LLC. Cover formation steps, EIN application, registered agent setup, state filing.
- "onboarding": client ALREADY HAS an existing LLC and is joining Tony Durante's ongoing management. Do NOT mention entity formation, LLC registration, or gathering formation documents — the company exists. Focus on: integrating into ongoing compliance management, collecting existing company documents, setting up accounting systems, understanding their current compliance state, registered agent and annual filing management going forward.
- "renewal": client is renewing an existing annual management agreement. Focus on continuity, service upgrades, and the upcoming year's compliance calendar.

Other rules:
- Output ONLY the JSON object. No markdown, no code fences, no explanation.
- All content must be relevant to the specific client and services selected.
- The intro must reference the client's actual situation, not be generic.
- Strategy and next_steps should reflect the specific services in the offer.
- Do NOT include pricing or amounts — those are handled separately.
- Do NOT include legal disclaimers — the contract handles those.`
}

function buildUserPrompt(
  clientName: string,
  language: string,
  services: string[],
  notesContext: string,
  contractType: string,
): string {
  return `Generate offer narrative content for this client:

CLIENT: ${clientName}
PREFERRED LANGUAGE: ${language === 'it' ? 'Italian' : 'English'}
CONTRACT TYPE: ${contractType}
SELECTED SERVICES: ${services.join(', ')}

NOTES & CONTEXT (internal — do not reproduce verbatim, use to personalize):
${notesContext || 'No additional notes provided.'}

Generate the JSON now.`
}

// ── Route handler ──

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'create_offer')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await req.json()
    const { client_name, language, services, notes_context, contract_type, lead_id, account_id } = body

    if (!client_name || !services || !Array.isArray(services) || services.length === 0) {
      return NextResponse.json(
        { error: 'client_name and services (non-empty array) are required' },
        { status: 400 },
      )
    }

    const lang: 'en' | 'it' = language === 'it' ? 'it' : 'en'
    const systemPrompt = buildSystemPrompt(lang)

    // Enrich the context with the client's actual call (notes + full transcript)
    // so the narrative is grounded in what they really said, not just the capped
    // summary the dialog pasted in. Best-effort — empty when no call exists.
    const callContext = await fetchCallContext(lead_id, account_id)
    const combinedContext = [notes_context || '', callContext]
      .filter((s) => s && s.trim())
      .join('\n\n──────────\n\n')

    const userPrompt = buildUserPrompt(
      client_name,
      lang,
      services as string[],
      combinedContext,
      contract_type || 'formation',
    )

    // AI generation via the shared provider (lib/portal/ai-provider.ts):
    // single source of truth for the model id (ANTHROPIC_MODELS.sonnet) PLUS
    // automatic Anthropic→OpenAI failover + timeout handling. Replaces the old
    // hardcoded fetch whose model string 404'd the day claude-sonnet-4-20250514
    // retired (2026-06-15) — with failover, a retired/broken model now degrades
    // to the fallback provider instead of erroring the offer dialog.
    let rawText: string
    try {
      const ai = await callAI({
        systemPrompt,
        userPrompt,
        maxTokens: 4096,
        temperature: 0.7,
        model: 'sonnet',
        // Large narrative generation is slow — the old 30s default silently
        // timed this out. 90s per attempt (Sonnet → Opus fallback) fits inside
        // the 300s maxDuration above.
        timeoutMs: 90_000,
      })
      rawText = ai.text
    } catch (err) {
      // Surface the real cause (admin-only route) instead of a generic message,
      // so a future failure is diagnosable from the toast (R099).
      const message = err instanceof Error ? err.message : 'AI generation failed'
      console.error('[generate-offer-narrative] AI generation failed:', message)
      await reportSystemError({
        source: 'server',
        route: '/api/crm/admin-actions/generate-offer-narrative',
        method: 'POST',
        http_status: 502,
        user_email: user?.email ?? null,
        message,
      })
      return NextResponse.json({ error: message }, { status: 502 })
    }

    if (!rawText) {
      return NextResponse.json({ error: 'AI returned empty response' }, { status: 502 })
    }

    // Parse JSON — strip markdown fences if present
    const jsonStr = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      console.error('[generate-offer-narrative] Failed to parse AI response:', rawText.substring(0, 500))
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 502 })
    }

    // Validate structure (language-aware: only require the matching intro)
    const validation = validateNarrative(parsed, lang)
    if ('result' in validation) {
      return NextResponse.json({ success: true, narrative: validation.result })
    }
    const errMsg = 'error' in validation ? validation.error : 'Unknown validation error'
    console.error('[generate-offer-narrative] Validation failed:', errMsg)
    return NextResponse.json(
      { error: `AI response validation failed: ${errMsg}` },
      { status: 502 },
    )
  } catch (err) {
    console.error('[generate-offer-narrative] Error:', err)
    await reportSystemError({
      source: 'server',
      route: '/api/crm/admin-actions/generate-offer-narrative',
      method: 'POST',
      http_status: 500,
      message: err instanceof Error ? err.message : 'Internal server error',
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}