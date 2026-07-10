/**
 * Pure filter predicate for the Conversations sidebar (topic + state filters).
 * Kept side-effect-free so it's unit-testable and the component just maps over it.
 */

export type ConversationStateFilter = 'all' | 'open' | 'solved' | 'closed'

export interface ConversationFilterInput {
  /** Topic display name; '' means "all topics". */
  topic: string
  state: ConversationStateFilter
}

export interface FilterableConversation {
  topic?: string | null
  resolution?: 'solved' | 'closed' | null
}

/**
 * Does this conversation pass the active topic + state filters?
 *  - topic '' matches all; otherwise exact topic-name match.
 *  - state 'all' matches all; 'open' = no resolution; 'solved'/'closed' = that resolution.
 */
export function matchesConversationFilter(
  t: FilterableConversation,
  f: ConversationFilterInput,
): boolean {
  if (f.topic && t.topic !== f.topic) return false
  if (f.state === 'open' && t.resolution) return false
  if (f.state === 'solved' && t.resolution !== 'solved') return false
  if (f.state === 'closed' && t.resolution !== 'closed') return false
  return true
}
