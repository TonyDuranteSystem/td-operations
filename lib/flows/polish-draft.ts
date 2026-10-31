/**
 * AI Polish for the Calendar / Flow Workspace "Message the client" box (Luca, td-bug 2026-10-28).
 * Calls the same route Portal Chats uses (/api/portal/chat/polish) — one polish brain, no copy.
 * Pure of React so the answer handling can be pinned by a test.
 */
export type PolishDraftResult =
  | { kind: 'polished'; text: string; appliedLanguage: string | null }
  | { kind: 'ask' } // the route could not tell which language to write in — the caller must ask staff

export async function requestPolish(
  input: {
    message: string
    accountId: string | null
    contactId: string | null
    preserveLanguage: boolean
    targetLanguage?: string
  },
  fetchFn: typeof fetch = fetch,
): Promise<PolishDraftResult> {
  const res = await fetchFn('/api/portal/chat/polish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: input.message,
      preserve_language: input.preserveLanguage,
      ...(input.targetLanguage ? { target_language: input.targetLanguage } : {}),
      ...(input.accountId ? { account_id: input.accountId } : {}),
      ...(input.contactId ? { contact_id: input.contactId } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to polish message')
  if (data.needs_language_choice) return { kind: 'ask' }
  if (!data.polished) throw new Error('AI polish returned nothing — please try again.')
  return { kind: 'polished', text: data.polished as string, appliedLanguage: (data.applied_language as string | null) ?? null }
}
