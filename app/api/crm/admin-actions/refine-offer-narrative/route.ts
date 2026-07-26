import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { validateNarrativeChanges, normalizeEntityType } from '@/lib/offer-narrative'
import {
  renderServiceLines,
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  type NarrativeServiceInput,
} from '@/lib/offers/narrative-business-rules'
import { loadOfferBusinessRules } from '@/lib/offers/load-business-rules'
import { getAllSellableServices } from '@/lib/services'
import { callAI } from '@/lib/portal/ai-provider'
import { reportSystemError } from '@/lib/system-errors'

/**
 * The full menu of services Tony Durante actually offers, so the refine model
 * never falsely claims TD doesn't offer something (e.g. opening a U.S. bank
 * account). Best-effort: empty on any error — the hard rules still hold.
 */
async function loadServiceMenu(): Promise<string> {
  try {
    const rows = await getAllSellableServices()
    return rows
      .map((r) => {
        const name = r.display_name || r.slug
        const desc = (r.description || '').trim()
        return desc ? `- ${name}: ${desc}` : `- ${name}`
      })
      .join('\n')
  } catch (err) {
    console.error('[refine-offer-narrative] service-menu load failed (non-fatal):', err instanceof Error ? err.message : err)
    return ''
  }
}

export const maxDuration = 120

/**
 * Conversational REFINE of an offer narrative. The staff member sends the CURRENT
 * narrative (including any hand-edits) + a plain instruction; the model returns
 * ONLY the sections it changed, so untouched sections are never clobbered. Same
 * editable business rules + scope + language as generation, so a refined offer
 * can't drift or over-promise. Draft-only: this returns the changed sections to
 * the dialog — it never writes to an offer or sends anything.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'create_offer')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await req.json()
    const { client_name, language, services, contract_type, entity_type, current, instruction } = body

    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      return NextResponse.json({ error: 'instruction is required' }, { status: 400 })
    }
    if (!current || typeof current !== 'object') {
      return NextResponse.json({ error: 'current narrative is required' }, { status: 400 })
    }
    if (!services || !Array.isArray(services) || services.length === 0) {
      return NextResponse.json({ error: 'services (non-empty array) are required' }, { status: 400 })
    }

    const serviceLines = renderServiceLines(services as NarrativeServiceInput[])
    if (serviceLines.length === 0) {
      return NextResponse.json({ error: 'services must contain at least one named service' }, { status: 400 })
    }

    const lang: 'en' | 'it' = language === 'it' ? 'it' : 'en'
    const contractType = contract_type || 'formation'

    const [businessRules, serviceMenu] = await Promise.all([
      loadOfferBusinessRules({ route: '/api/crm/admin-actions/refine-offer-narrative', userEmail: user?.email }),
      loadServiceMenu(),
    ])

    const systemPrompt = buildRefineSystemPrompt(lang, businessRules, serviceMenu)
    const userPrompt = buildRefineUserPrompt({
      clientName: client_name || 'the client',
      contractType,
      entityType: normalizeEntityType(entity_type),
      serviceLines,
      current: {
        intro_en: typeof current.intro_en === 'string' ? current.intro_en : '',
        intro_it: typeof current.intro_it === 'string' ? current.intro_it : '',
        strategy: typeof current.strategy === 'string' ? current.strategy : '',
        next_steps: typeof current.next_steps === 'string' ? current.next_steps : '',
        future_developments: typeof current.future_developments === 'string' ? current.future_developments : '',
        immediate_actions: typeof current.immediate_actions === 'string' ? current.immediate_actions : '',
      },
      instruction: instruction.trim(),
    })

    let rawText: string
    try {
      // temperature 0: a refine must be a precise, minimal edit — not a creative
      // regeneration that quietly reshapes untouched sections.
      const ai = await callAI({ systemPrompt, userPrompt, maxTokens: 2048, temperature: 0, model: 'sonnet', timeoutMs: 90_000 })
      rawText = ai.text
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI refine failed'
      console.error('[refine-offer-narrative] AI refine failed:', message)
      await reportSystemError({
        source: 'server', route: '/api/crm/admin-actions/refine-offer-narrative', method: 'POST',
        http_status: 502, user_email: user?.email ?? null, message,
      }).catch(() => {})
      return NextResponse.json({ error: message }, { status: 502 })
    }

    if (!rawText) return NextResponse.json({ error: 'AI returned empty response' }, { status: 502 })

    const jsonStr = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      console.error('[refine-offer-narrative] Failed to parse AI response:', rawText.substring(0, 500))
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 502 })
    }

    const validation = validateNarrativeChanges(parsed, lang)
    if ('error' in validation) {
      console.error('[refine-offer-narrative] Validation failed:', validation.error)
      return NextResponse.json({ error: `AI response validation failed: ${validation.error}` }, { status: 502 })
    }

    return NextResponse.json({ success: true, note: validation.note, changes: validation.changes })
  } catch (err) {
    console.error('[refine-offer-narrative] Error:', err)
    await reportSystemError({
      source: 'server', route: '/api/crm/admin-actions/refine-offer-narrative', method: 'POST',
      http_status: 500, message: err instanceof Error ? err.message : 'Internal server error',
    }).catch(() => {})
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
