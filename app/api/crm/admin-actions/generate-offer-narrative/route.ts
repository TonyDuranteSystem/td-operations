import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { validateNarrative } from '@/lib/offer-narrative'

// ── System prompt ──

function buildSystemPrompt(): string {
  return `You are a senior business consultant writing client-facing offer content for Tony Durante LLC, a professional consulting firm based in Florida that helps international entrepreneurs set up and manage U.S. LLCs.

Your writing style is:
- Professional but warm and approachable
- Clear and concise — no filler or jargon
- Confident and authoritative about the services
- Tailored to the specific client situation based on the notes provided

You must produce ALL output as a single JSON object with exactly these keys:
- "intro_en": A 2-4 sentence personalized introduction in English. Address the client by name. Reference their specific situation from the notes. Explain what this offer covers.
- "intro_it": The Italian translation of intro_en. Must be natural Italian, not machine-translated.
- "strategy": An array of 3-5 strategic steps. Each: { "step_number": N, "title": "Short Title", "description": "1-2 sentence explanation" }. These describe the overall approach/plan for the client.
- "next_steps": An array of 3-5 next steps after signing. Each: { "step_number": N, "title": "Short Title", "description": "1-2 sentence explanation" }. These describe what happens operationally after the client signs.
- "future_developments": An array of 2-4 items. Each: { "text": "Description of a future opportunity" }. These are optional services or growth opportunities for later.
- "immediate_actions": An array of 2-4 items. Each: { "title": "Action Name", "description": "What needs to happen and why" }. These are things to address right away.

Rules:
- Output ONLY the JSON object. No markdown, no code fences, no explanation.
- All content must be relevant to the specific client and services selected.
- The intro must reference the client's actual situation, not be generic.
- Strategy and next_steps should reflect the specific services in the offer.
- Do NOT include pricing or amounts — those are handled separately.
- Do NOT include legal disclaimers — the contract handles those.
- Keep each description under 2 sentences.`
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

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'AI provider not configured' }, { status: 503 })
    }

    const systemPrompt = buildSystemPrompt()
    const userPrompt = buildUserPrompt(
      client_name,
      language || 'en',
      services as string[],
      notes_context || '',
      contract_type || 'formation',
    )

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0.7,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        console.error('[generate-offer-narrative] Anthropic API error:', res.status, err)
        return NextResponse.json(
          { error: `AI generation failed (${res.status})` },
          { status: 502 },
        )
      }

      const data = await res.json()
      const rawText = data.content?.[0]?.text?.trim()

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

      // Validate structure
      const validation = validateNarrative(parsed)
      if ('result' in validation) {
        return NextResponse.json({ success: true, narrative: validation.result })
      }
      const errMsg = 'error' in validation ? validation.error : 'Unknown validation error'
      console.error('[generate-offer-narrative] Validation failed:', errMsg)
      return NextResponse.json(
        { error: `AI response validation failed: ${errMsg}` },
        { status: 502 },
      )
    } catch (err: unknown) {
      clearTimeout(timeout)
      if (err instanceof Error && err.name === 'AbortError') {
        return NextResponse.json({ error: 'AI generation timed out (30s)' }, { status: 504 })
      }
      throw err
    }
  } catch (err) {
    console.error('[generate-offer-narrative] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}