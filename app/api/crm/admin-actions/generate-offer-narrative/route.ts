import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { validateNarrative } from '@/lib/offer-narrative'
import { callAI } from '@/lib/portal/ai-provider'

// ── System prompt ──

function buildSystemPrompt(language: 'en' | 'it'): string {
  // Single-language intro — match the client's preferred language only.
  // 2026-05-07: previously generated BOTH intros; the access-code offer page
  // renders both fields side-by-side, which produced unwanted bilingual
  // welcome blocks for monolingual clients (Mojo / Sanjin case). Generator
  // now produces only the matching intro and leaves the other empty.
  const introSpec = language === 'it'
    ? `- "intro_it": A 2-4 sentence personalized introduction in NATURAL Italian (not machine-translated). Address the client by name. Reference their specific situation from the notes. Explain what this offer covers.
- "intro_en": MUST be an empty string "". Do not produce English intro content.`
    : `- "intro_en": A 2-4 sentence personalized introduction in English. Address the client by name. Reference their specific situation from the notes. Explain what this offer covers.
- "intro_it": MUST be an empty string "". Do not produce Italian intro content.`

  const otherSectionsLang = language === 'it' ? 'Italian' : 'English'

  return `You are a senior business consultant writing client-facing offer content for Tony Durante LLC, a professional consulting firm based in Florida that helps international entrepreneurs set up and manage U.S. LLCs.

Your writing style is:
- Professional but warm and approachable
- Clear and concise — no filler or jargon
- Confident and authoritative about the services
- Tailored to the specific client situation based on the notes provided

You must produce ALL output as a single JSON object with exactly these keys:
${introSpec}
- "call_summary": A DETAILED, client-facing recap of the consultation call, written in ${otherSectionsLang}. Summarize what the client shared: their business and current situation, what they are trying to achieve, the specific needs/concerns they raised, and what was discussed or agreed during the call. Write 1-2 well-developed paragraphs (4-8 sentences total) in a warm, professional second-person voice (e.g. "During our call, you shared that..."). This is the ONE field that should be thorough — do NOT compress it. CLIENT-SAFETY RULE: base it ONLY on what the client themselves described. Do NOT include internal staff assessments, our private opinions about the client, pricing strategy, or any remark the client did not actually make — the notes may contain internal commentary; exclude all of it. If the notes contain NO information about an actual call with the client, set this field to an empty string "".
- "strategy": An array of 3-5 strategic steps. Each: { "step_number": N, "title": "Short Title", "description": "1-2 sentence explanation" }. These describe the overall approach/plan for the client.
- "next_steps": An array of 3-5 next steps after signing. Each: { "step_number": N, "title": "Short Title", "description": "1-2 sentence explanation" }. These describe what happens operationally after the client signs.
- "future_developments": An array of 2-4 items. Each: { "text": "Description of a future opportunity" }. These are optional services or growth opportunities for later.
- "immediate_actions": An array of 2-4 items. Each: { "title": "Action Name", "description": "What needs to happen and why" }. These are things to address right away.

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
- Do NOT include legal disclaimers — the contract handles those.
- Keep each strategy / next_steps / future_developments / immediate_actions description under 2 sentences. This brevity rule does NOT apply to "call_summary", which should be detailed.`
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
    const { client_name, language, services, notes_context, contract_type } = body

    if (!client_name || !services || !Array.isArray(services) || services.length === 0) {
      return NextResponse.json(
        { error: 'client_name and services (non-empty array) are required' },
        { status: 400 },
      )
    }

    const lang: 'en' | 'it' = language === 'it' ? 'it' : 'en'
    const systemPrompt = buildSystemPrompt(lang)
    const userPrompt = buildUserPrompt(
      client_name,
      lang,
      services as string[],
      notes_context || '',
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
        maxTokens: 3000,
        temperature: 0.7,
        model: 'sonnet',
      })
      rawText = ai.text
    } catch (err) {
      console.error('[generate-offer-narrative] AI generation failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'AI generation failed' }, { status: 502 })
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}