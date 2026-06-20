/**
 * Offer narrative types and validation.
 * Shared between the generation API endpoint and unit tests.
 */

/** One transcript turn as stored in call_summaries.transcript (shape varies). */
export interface CallTranscriptTurn {
  speaker?: string
  name?: string
  text?: string
  content?: string
}

/** A call_summaries row, narrowed to the fields the offer generator uses. */
export interface OfferCallContext {
  meeting_name?: string | null
  created_at?: string | null
  notes?: string | null
  transcript?: unknown
}

/**
 * Render a call's notes + full transcript into a plain-text block to feed the
 * offer-narrative AI as richer context. Pure + exported so it's unit-tested
 * without a DB/AI call. Returns "" when there's nothing useful to add (so the
 * caller can cleanly fall back to notes-only). The transcript is capped at
 * `charCap` to protect the model's token budget — full intake calls can be huge,
 * and the generator needs the gist of the client's situation, not every word.
 */
export function renderCallForOffer(call: OfferCallContext | null | undefined, charCap = 14000): string {
  if (!call) return ''
  const sections: string[] = []
  if (call.notes && typeof call.notes === 'string' && call.notes.trim()) {
    sections.push(`Call notes:\n${call.notes.trim()}`)
  }
  const transcript = Array.isArray(call.transcript) ? (call.transcript as CallTranscriptTurn[]) : null
  if (transcript && transcript.length) {
    const turns: string[] = []
    for (const t of transcript) {
      const speaker = (t.speaker || t.name || '?').toString().trim() || '?'
      const text = (t.text || t.content || '').toString().trim()
      if (!text) continue
      turns.push(`[${speaker}]: ${text}`)
    }
    if (turns.length) sections.push(`Full call transcript (${turns.length} turns):\n${turns.join('\n')}`)
  }
  if (sections.length === 0) return ''
  const header = call.meeting_name ? `Call: ${call.meeting_name}` : 'Client intake call'
  let out = `${header}\n\n${sections.join('\n\n')}`
  if (out.length > charCap) out = out.slice(0, charCap) + '\n…(transcript truncated)'
  return out
}

export interface NarrativeResponse {
  intro_en: string
  intro_it: string
  strategy: Array<{ step_number: number; title: string; description: string }>
  next_steps: Array<{ step_number: number; title: string; description: string }>
  future_developments: Array<{ text: string }>
  immediate_actions: Array<{ title: string; description: string }>
}

export const NARRATIVE_KEYS: (keyof NarrativeResponse)[] = [
  'intro_en', 'intro_it', 'strategy', 'next_steps',
  'future_developments', 'immediate_actions',
]

/**
 * Validate the narrative response from the AI generator.
 *
 * `language` controls which intro field is required:
 *   - 'en'  → only `intro_en` must be a non-empty string. `intro_it` may be
 *            absent, empty string, or null (and is normalized to empty).
 *   - 'it'  → only `intro_it` must be a non-empty string.
 *   - undefined → both required (legacy behavior — kept for back-compat with
 *                 callers that haven't been updated yet).
 *
 * Single-language mode was added 2026-05-07 so the offer page renders only
 * the client's preferred language. The contract page checks `intro_en` and
 * `intro_it` independently, so leaving the other field empty makes the
 * "secondary language" block disappear from the offer page.
 */
export function validateNarrative(
  data: unknown,
  language?: 'en' | 'it',
): { valid: true; result: NarrativeResponse } | { valid: false; error: string } {
  if (!data || typeof data !== 'object') return { valid: false, error: 'Response is not an object' }
  const obj = data as Record<string, unknown>

  if (language === 'en') {
    if (typeof obj.intro_en !== 'string' || !obj.intro_en.trim()) {
      return { valid: false, error: 'intro_en must be a non-empty string' }
    }
    // intro_it must be absent / empty / null in single-language mode
    if (obj.intro_it != null && obj.intro_it !== '' && (typeof obj.intro_it !== 'string' || obj.intro_it.trim() !== '')) {
      return { valid: false, error: 'intro_it must be empty when language is en' }
    }
    obj.intro_it = ''
  } else if (language === 'it') {
    if (typeof obj.intro_it !== 'string' || !obj.intro_it.trim()) {
      return { valid: false, error: 'intro_it must be a non-empty string' }
    }
    if (obj.intro_en != null && obj.intro_en !== '' && (typeof obj.intro_en !== 'string' || obj.intro_en.trim() !== '')) {
      return { valid: false, error: 'intro_en must be empty when language is it' }
    }
    obj.intro_en = ''
  } else {
    // Legacy: both required
    if (typeof obj.intro_en !== 'string' || !obj.intro_en.trim()) {
      return { valid: false, error: 'intro_en must be a non-empty string' }
    }
    if (typeof obj.intro_it !== 'string' || !obj.intro_it.trim()) {
      return { valid: false, error: 'intro_it must be a non-empty string' }
    }
  }

  // strategy: array of { step_number, title, description }
  if (!Array.isArray(obj.strategy) || obj.strategy.length === 0) {
    return { valid: false, error: 'strategy must be a non-empty array' }
  }
  for (const s of obj.strategy) {
    if (typeof s !== 'object' || !s) return { valid: false, error: 'strategy items must be objects' }
    const item = s as Record<string, unknown>
    if (typeof item.step_number !== 'number' || typeof item.title !== 'string' || typeof item.description !== 'string') {
      return { valid: false, error: 'strategy items must have step_number (number), title (string), description (string)' }
    }
  }

  // next_steps: same structure as strategy
  if (!Array.isArray(obj.next_steps) || obj.next_steps.length === 0) {
    return { valid: false, error: 'next_steps must be a non-empty array' }
  }
  for (const s of obj.next_steps) {
    if (typeof s !== 'object' || !s) return { valid: false, error: 'next_steps items must be objects' }
    const item = s as Record<string, unknown>
    if (typeof item.step_number !== 'number' || typeof item.title !== 'string' || typeof item.description !== 'string') {
      return { valid: false, error: 'next_steps items must have step_number (number), title (string), description (string)' }
    }
  }

  // future_developments: array of { text }
  if (!Array.isArray(obj.future_developments) || obj.future_developments.length === 0) {
    return { valid: false, error: 'future_developments must be a non-empty array' }
  }
  for (const f of obj.future_developments) {
    if (typeof f !== 'object' || !f) return { valid: false, error: 'future_developments items must be objects' }
    if (typeof (f as Record<string, unknown>).text !== 'string') {
      return { valid: false, error: 'future_developments items must have text (string)' }
    }
  }

  // immediate_actions: array of { title, description }
  if (!Array.isArray(obj.immediate_actions) || obj.immediate_actions.length === 0) {
    return { valid: false, error: 'immediate_actions must be a non-empty array' }
  }
  for (const a of obj.immediate_actions) {
    if (typeof a !== 'object' || !a) return { valid: false, error: 'immediate_actions items must be objects' }
    const item = a as Record<string, unknown>
    if (typeof item.title !== 'string' || typeof item.description !== 'string') {
      return { valid: false, error: 'immediate_actions items must have title (string), description (string)' }
    }
  }

  return { valid: true, result: obj as unknown as NarrativeResponse }
}
