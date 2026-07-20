/**
 * Finding a tool by describing it in English.
 *
 * THE BUG THIS REPLACES (measured 2026-07-20, end-to-end run). The old search asked
 * whether the ENTIRE query appeared, verbatim, inside a tool's name or description. So a
 * single word worked and a sentence never did. Against the real catalog of 216 tools:
 * "add note to account" → 0, "account note" → 0, "log conversation" → 0, "note on
 * account" → 0, "add a note" → 0, "record conversation" → 0, "update account notes" → 0.
 * Every one of those had a perfectly good tool sitting in the catalog.
 *
 * The consequence was not a visible error. The assistant asked for a tool the way a person
 * would, got "no tools match", concluded it had no way to do the job, and told the staff
 * member to do it by hand — while saying things like "I could propose setting it to…". It
 * wanted to act and could not find its own hands. That failure is almost certainly behind
 * earlier episodes in this job too: inventing a fake way to produce a PDF, and pointing at
 * the Slack bot, both after failed lookups.
 *
 * WHAT THIS DOES INSTEAD: scores each tool by how many of the query's WORDS it matches,
 * and returns the best. A name match counts for more than a description match, because a
 * tool called `conv_log` is a better answer for "log conversation" than some unrelated
 * tool whose description happens to mention conversations. An exact phrase still wins
 * outright, so anything the old search found, this finds too — it only ever adds results.
 *
 * DELIBERATELY NOT a fuzzy/semantic search. No embeddings, no edit distance. Ranked word
 * overlap is enough for a 216-item catalog, it is instant, it needs no model call, and its
 * behaviour is obvious from reading it — which matters for something the assistant's whole
 * reach depends on. If it ever proves insufficient, the failing phrase is the test case.
 */

export interface SearchableTool {
  name: string
  description: string
}

/**
 * Words carrying no signal about WHICH tool is wanted. Kept deliberately short: only
 * grammar words. Verbs like "add", "send", "log" stay, because they are often the most
 * discriminating word in the query ("log" is what finds the conversation logger).
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'my', 'me', 'it', 'its',
  'this', 'that', 'with', 'from', 'at', 'by', 'is', 'are', 'be', 'as', 'i', 'we', 'do',
  'can', 'you', 'please', 'need', 'want', 'how',
])

/** Split a query into the words worth matching on. */
export function queryTerms(query: string): string[] {
  return (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * How well one tool answers one query. 0 means "don't show it".
 *
 * Name matches outrank description matches: the catalog's names are deliberate
 * (`conv_log`, `crm_update_record`), while descriptions mention many things in passing —
 * ranking on descriptions alone buries the obvious answer under incidental mentions.
 */
export function scoreTool(tool: SearchableTool, query: string): number {
  const name = tool.name.toLowerCase()
  const desc = (tool.description ?? '').toLowerCase()
  const phrase = (query ?? '').toLowerCase().trim()

  let score = 0
  // Exact phrase — everything the OLD search could find, so this is strictly additive.
  if (phrase.length > 1) {
    if (name.includes(phrase)) score += 10
    else if (desc.includes(phrase)) score += 5
  }

  for (const term of queryTerms(query)) {
    // Substring rather than whole-word so "note" finds "notes" and "invoice" finds
    // "invoices" — plurals are the single most common near-miss in these queries.
    if (name.includes(term)) score += 3
    else if (desc.includes(term)) score += 1
    // ...and the other direction: a plural query term against a singular name.
    else if (term.endsWith('s') && term.length > 3) {
      const singular = term.slice(0, -1)
      if (name.includes(singular)) score += 3
      else if (desc.includes(singular)) score += 1
    }
  }
  return score
}

/**
 * The best matches for a query, most relevant first.
 *
 * Ties break on name so the output is stable — an assistant re-running the same search
 * mid-conversation should not see the list reshuffle underneath it.
 */
export function searchTools<T extends SearchableTool>(tools: readonly T[], query: string, limit = 15): T[] {
  const scored = tools
    .map((t) => ({ t, score: scoreTool(t, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
  return scored.slice(0, limit).map((r) => r.t)
}

/**
 * Render the result for the assistant, or say plainly that nothing matched.
 *
 * The empty case names the words actually searched on. When a lookup fails, the assistant
 * has to decide between rephrasing and telling the staff member it cannot help — and it
 * chose wrong for weeks. Showing the terms makes a retry the obvious next move.
 */
export function formatToolSearch(tools: readonly SearchableTool[], query: string, limit = 15): string {
  const hits = searchTools(tools, query, limit)
  if (!hits.length) {
    const terms = queryTerms(query)
    return terms.length
      ? `No tools match "${query}" (searched for: ${terms.join(', ')}). Try one key word on its own, e.g. "${terms[terms.length - 1]}".`
      : `No tools match "${query}". Try a single key word, like "invoice" or "task".`
  }
  return hits.map((t) => `• ${t.name} — ${(t.description ?? '').split(/\. |\n/)[0]}`).join('\n')
}
