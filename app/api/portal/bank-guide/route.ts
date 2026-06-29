/**
 * POST /api/portal/bank-guide  { bank: string, locale?: 'en' | 'it' }
 *
 * Returns CSV-export instructions for ANY bank the client types — not limited
 * to a hardcoded list. Resolution:
 *   1. Catalog match (curated/known banks)              → instant, free
 *   2. AI-generate steps for this bank + cache to catalog → grows the library
 *   3. Generic fallback (AI unavailable / unknown input) → never leaves empty
 *
 * Auth: any logged-in portal user. The response is generic public guidance
 * (no account data), so we only gate on a valid session.
 *
 * See lib/tax/bank-guide.ts for the pure helpers + design notes.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import {
  type BankGuide,
  normalizeBankName,
  bankSlug,
  findGuide,
  genericGuideSteps,
  GUIDE_TOOL,
  buildGuidePrompt,
  validateGuide,
} from '@/lib/tax/bank-guide'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MODEL = process.env.BANK_GUIDE_MODEL || 'claude-sonnet-4-6'

function genericResponse(bank: string, locale: string) {
  const g = genericGuideSteps(locale === 'it' ? 'it' : 'en')
  return {
    source: 'generic' as const,
    guide: {
      name: bank.trim().slice(0, 80) || 'your bank',
      steps: g.steps,
      note: g.note,
    },
  }
}

async function loadCatalogGuides(): Promise<BankGuide[]> {
  const { data } = await supabaseAdmin
    .from('catalog_entries')
    .select('display_name, metadata')
    .eq('catalog_id', 'bank_export_guides')
    .eq('status', 'active')
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  return (data ?? [])
    .map(r => {
      const m = (r.metadata ?? {}) as Record<string, unknown>
      return {
        name: r.display_name as string,
        matchTerms: arr(m.match_terms),
        stepsEn: arr(m.steps_en),
        stepsIt: arr(m.steps_it),
        noteEn: typeof m.note_en === 'string' ? m.note_en : '',
        noteIt: typeof m.note_it === 'string' ? m.note_it : '',
      }
    })
    .filter(g => g.matchTerms.length > 0 && g.stepsEn.length > 0)
}

function localized(guide: BankGuide, locale: string) {
  const it = locale === 'it'
  return {
    name: guide.name,
    steps: it && guide.stepsIt.length > 0 ? guide.stepsIt : guide.stepsEn,
    note: it && guide.noteIt ? guide.noteIt : guide.noteEn,
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const bankRaw = String((body as { bank?: unknown }).bank ?? '').slice(0, 80)
    const locale = String((body as { locale?: unknown }).locale ?? 'en') === 'it' ? 'it' : 'en'
    const norm = normalizeBankName(bankRaw)
    if (norm.length < 2) {
      return NextResponse.json({ error: 'Please type a bank name.' }, { status: 400 })
    }

    // 1 — catalog match (curated + previously cached AI guides)
    const guides = await loadCatalogGuides()
    const matched = findGuide(bankRaw, guides)
    if (matched) {
      return NextResponse.json({ source: 'catalog', guide: localized(matched, locale) })
    }

    // 2 — AI generate + cache
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return NextResponse.json(genericResponse(bankRaw, locale))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25_000)
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          tools: [GUIDE_TOOL],
          tool_choice: { type: 'tool', name: 'record_bank_guide' },
          messages: [{ role: 'user', content: buildGuidePrompt(bankRaw) }],
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // spend cap (400), rate limit, transient — degrade gracefully
        return NextResponse.json(genericResponse(bankRaw, locale))
      }
      const data = await res.json()
      const toolUse = (data.content ?? []).find(
        (b: { type: string; name?: string }) => b.type === 'tool_use' && b.name === 'record_bank_guide',
      )
      const guide = toolUse ? validateGuide(toolUse.input ?? {}, bankRaw) : null
      if (!guide) return NextResponse.json(genericResponse(bankRaw, locale))

      // Cache to catalog so the next client hits path #1. Best-effort: a failed
      // write must never break the response.
      try {
        await supabaseAdmin.from('catalog_entries').upsert(
          {
            catalog_id: 'bank_export_guides',
            slug: bankSlug(guide.name) || bankSlug(bankRaw),
            display_name: guide.name,
            status: 'active',
            metadata: {
              match_terms: guide.matchTerms,
              steps_en: guide.stepsEn,
              steps_it: guide.stepsIt,
              note_en: guide.noteEn,
              note_it: guide.noteIt,
              source: 'ai_generated',
            },
          },
          { onConflict: 'catalog_id,slug' },
        )
      } catch {
        /* non-fatal */
      }

      return NextResponse.json({ source: 'ai', guide: localized(guide, locale) })
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    // Last-resort: still hand back generic guidance rather than an error toast.
    const locale = 'en'
    return NextResponse.json(genericResponse('your bank', locale), { status: 200 })
  }
}
