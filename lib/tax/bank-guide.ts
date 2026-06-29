/**
 * Bank CSV-export guides — flexible, any-bank lookup.
 *
 * The "Before You Start" tax-wizard step lets a client type ANY bank name and
 * get step-by-step instructions for downloading their transactions as a CSV.
 *
 * Resolution order (see app/api/portal/bank-guide/route.ts):
 *   1. CATALOG match — curated/known banks (catalog_entries 'bank_export_guides').
 *      Fast, free, human-reviewed. Matched by `match_terms`.
 *   2. AI-GENERATED — if no catalog match, Claude generates concise CSV-export
 *      steps for that specific bank, which we cache back into the catalog so the
 *      next client who types it gets the catalog path. The library grows itself;
 *      nothing is hardcoded to a fixed bank list.
 *   3. GENERIC fallback — if AI is unavailable (e.g. no API key / spend cap) we
 *      still return universal "log in → transactions → export CSV" guidance so
 *      the client is never left without an answer.
 *
 * This module holds the PURE, DB-free, network-free helpers so they are unit
 * testable. The route wires them to Supabase + the Anthropic API.
 */

export type BankGuide = {
  name: string
  matchTerms: string[]
  stepsEn: string[]
  stepsIt: string[]
  noteEn: string
  noteIt: string
}

/** Lowercase, trim, collapse internal whitespace. Used for matching + tokens. */
export function normalizeBankName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Kebab slug for the catalog row (stable cache key per bank). */
export function bankSlug(raw: string): string {
  return normalizeBankName(raw)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Find a catalog guide whose match terms appear in the typed query.
 * Mirrors the client-side matcher: a term matches when the normalized query
 * contains it. Longer terms win (more specific) to avoid a 2-char term like
 * "n2" shadowing "n26".
 */
export function findGuide(query: string, guides: BankGuide[]): BankGuide | null {
  const q = normalizeBankName(query)
  if (q.length < 2) return null
  let best: { guide: BankGuide; term: string } | null = null
  for (const g of guides) {
    for (const term of g.matchTerms) {
      const t = normalizeBankName(term)
      if (t.length >= 2 && q.includes(t)) {
        if (!best || t.length > best.term.length) best = { guide: g, term: t }
      }
    }
  }
  return best?.guide ?? null
}

/**
 * Derive match terms for a freshly generated guide so future lookups hit the
 * catalog. Includes the full normalized name and its individual word tokens
 * (≥3 chars), deduped. e.g. "N26 Bank" → ["n26 bank", "n26", "bank"].
 */
export function deriveMatchTerms(bankName: string): string[] {
  const norm = normalizeBankName(bankName)
  const terms = new Set<string>()
  if (norm.length >= 2) terms.add(norm)
  for (const tok of norm.split(' ')) {
    if (tok.length >= 3 && tok !== 'bank' && tok !== 'the') terms.add(tok)
  }
  return Array.from(terms)
}

/** Universal fallback steps when no specific guide is available. */
export function genericGuideSteps(locale: string): { steps: string[]; note: string } {
  if (locale === 'it') {
    return {
      steps: [
        'Accedi al sito web o all’app della tua banca.',
        'Apri la sezione Transazioni / Movimenti / Attività del conto.',
        'Imposta l’intervallo di date sull’intero anno fiscale (1 gennaio – 31 dicembre).',
        'Cerca un pulsante Esporta / Scarica e scegli il formato CSV (non PDF).',
        'Ripeti per ogni conto/valuta e carica i file nello step finale.',
      ],
      note: 'Se la tua banca non offre il CSV, scarica il formato Excel/foglio di calcolo: va bene comunque.',
    }
  }
  return {
    steps: [
      'Log in to your bank’s website or app.',
      'Open the Transactions / Activity / Statements section.',
      'Set the date range to the full tax year (Jan 1 – Dec 31).',
      'Look for an Export / Download button and choose CSV (not PDF).',
      'Repeat for each account/currency and upload the files in the final step.',
    ],
    note: 'If your bank doesn’t offer CSV, an Excel/spreadsheet export works too.',
  }
}

/** Anthropic tool schema forcing structured guide output. */
export const GUIDE_TOOL = {
  name: 'record_bank_guide',
  description: 'Record step-by-step instructions for downloading bank transactions as a CSV file.',
  input_schema: {
    type: 'object',
    properties: {
      display_name: {
        type: 'string',
        description: 'The clean, correctly-capitalized bank/fintech name (e.g. "N26", "Bank of America").',
      },
      is_real_bank: {
        type: 'boolean',
        description: 'True if this is a recognizable bank, fintech, or payment provider. False for gibberish/unknown input.',
      },
      steps_en: {
        type: 'array',
        items: { type: 'string' },
        description: '3–6 short imperative steps in English to export the full year of transactions as CSV.',
      },
      steps_it: {
        type: 'array',
        items: { type: 'string' },
        description: 'The same steps translated to Italian.',
      },
      note_en: { type: 'string', description: 'One short caveat in English (optional).' },
      note_it: { type: 'string', description: 'The note translated to Italian (optional).' },
    },
    required: ['display_name', 'is_real_bank', 'steps_en', 'steps_it'],
  },
} as const

export function buildGuidePrompt(bankName: string): string {
  return [
    `A client of a US tax-prep firm banks with "${bankName}".`,
    'They need to download ALL of their transactions for one tax year as a CSV file to send for bookkeeping.',
    'Give concise, accurate step-by-step instructions to export a CSV of transactions from this specific bank or fintech.',
    'Focus on: where to find the export, choosing the full date range (a whole year), and selecting CSV (not PDF).',
    'Keep each step short and action-oriented. Provide both English and Italian.',
    'If the name is not a recognizable bank/fintech/payment provider, set is_real_bank=false and return generic export steps.',
  ].join(' ')
}

type GuideInput = {
  display_name?: unknown
  is_real_bank?: unknown
  steps_en?: unknown
  steps_it?: unknown
  note_en?: unknown
  note_it?: unknown
}

/**
 * Validate + clamp the model output into a BankGuide. Returns null if the
 * result is unusable (not a real bank, or no usable steps) so the caller falls
 * back to the generic guide rather than caching junk.
 */
export function validateGuide(input: GuideInput, fallbackName: string): BankGuide | null {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 8).map(s => s.slice(0, 240))
      : []
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 240) : '')

  if (input.is_real_bank === false) return null
  const stepsEn = strArr(input.steps_en)
  const stepsIt = strArr(input.steps_it)
  if (stepsEn.length < 2) return null // not enough to be a real guide

  const name = str(input.display_name) || fallbackName.trim().slice(0, 80)
  if (!name) return null

  return {
    name,
    matchTerms: deriveMatchTerms(name).concat(deriveMatchTerms(fallbackName)).filter((v, i, a) => a.indexOf(v) === i),
    stepsEn,
    stepsIt: stepsIt.length > 0 ? stepsIt : stepsEn,
    noteEn: str(input.note_en),
    noteIt: str(input.note_it),
  }
}
