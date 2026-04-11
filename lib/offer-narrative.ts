/**
 * Offer narrative types and validation.
 * Shared between the generation API endpoint and unit tests.
 */

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

export function validateNarrative(data: unknown): { valid: true; result: NarrativeResponse } | { valid: false; error: string } {
  if (!data || typeof data !== 'object') return { valid: false, error: 'Response is not an object' }
  const obj = data as Record<string, unknown>

  // intro_en and intro_it must be strings
  if (typeof obj.intro_en !== 'string' || !obj.intro_en.trim()) {
    return { valid: false, error: 'intro_en must be a non-empty string' }
  }
  if (typeof obj.intro_it !== 'string' || !obj.intro_it.trim()) {
    return { valid: false, error: 'intro_it must be a non-empty string' }
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
