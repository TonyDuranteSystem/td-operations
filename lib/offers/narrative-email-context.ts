import { supabaseAdmin } from '@/lib/supabase-admin'
import { callAI } from '@/lib/portal/ai-provider'
import { executeTool } from '@/lib/ai-agent/tools'
import { resolvePrimaryContact } from '@/lib/members/resolve-primary-contact'

/**
 * Resolve the one email address to scope a lookup to — whichever of
 * contact/lead/account this offer is actually for. Best-effort: undefined on
 * no match or any error, so a missing link just means no email lookup runs.
 */
export async function resolveSubjectEmail(opts: {
  contactId?: string | null
  leadId?: string | null
  accountId?: string | null
}): Promise<string | undefined> {
  try {
    if (opts.contactId) {
      const { data } = await supabaseAdmin.from('contacts').select('email').eq('id', opts.contactId).maybeSingle()
      if (data?.email) return data.email
    }
    if (opts.leadId) {
      const { data } = await supabaseAdmin.from('leads').select('email').eq('id', opts.leadId).maybeSingle()
      if (data?.email) return data.email
    }
    if (opts.accountId) {
      const primary = await resolvePrimaryContact(opts.accountId)
      if (primary.outcome === 'resolved' && primary.contact.email) return primary.contact.email
    }
  } catch (err) {
    console.error('[narrative-email-context] subject-email resolution failed (non-fatal):', err instanceof Error ? err.message : err)
  }
  return undefined
}

/**
 * Read-only email lookup for a refine instruction — the "Discuss with AI"
 * counterpart to fetchCallContext() in the sibling generate-offer-narrative
 * route. Reuses the SAME gmail_search/gmail_read_thread implementations the
 * dashboard's read-only AI worker already calls (lib/ai-agent/tools.ts —
 * gated read-only there via WORKER_READ_ONLY_TOOL_NAMES); this calls them
 * directly rather than pulling in that worker's full conversational engine,
 * which is a heavier, stateful, approval-gated system built for a different
 * job (and whose UNGATED predecessor was retired specifically because it let
 * a model dispatch tool calls, including sends, with no permission step —
 * see app/api/ai-agent/route.ts's 2026-07-19 note). This path is read-only
 * end to end: it can only find and quote an email back into the prompt,
 * never send or write anything.
 *
 * Two-step, both best-effort (any failure or empty result just means no
 * context — the caller proceeds exactly as it did before this existed):
 * 1. A cheap, deterministic classification call decides whether the
 *    instruction actually references an email at all, so an ordinary
 *    "shorten the intro" doesn't pay for a Gmail round trip it doesn't need.
 * 2. If so, search scoped to the client's own address (never an open,
 *    unscoped inbox search) and read the top matching thread.
 */
export async function findRelevantEmailContext(
  instruction: string,
  subjectEmail: string | undefined,
): Promise<string | undefined> {
  if (!subjectEmail) return undefined
  try {
    const classify = await callAI({
      systemPrompt:
        'Decide whether answering the instruction requires looking up a specific email. Reply with ONLY a JSON object: {"needs_email": true|false, "query": "<a few Gmail search keywords — names, topics, dates mentioned>"}. Only set needs_email true when the instruction refers to something said or written in an email, or by a specific person, that is not already given as plain context.',
      userPrompt: instruction,
      maxTokens: 150,
      temperature: 0,
      model: 'sonnet',
      timeoutMs: 20_000,
    })
    const jsonStr = classify.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const decision = JSON.parse(jsonStr) as { needs_email?: boolean; query?: string }
    if (!decision.needs_email) return undefined

    const query = `${decision.query || ''} (from:${subjectEmail} OR to:${subjectEmail})`.trim()
    const searchRaw = await executeTool('gmail_search', { query, max_results: 5 })
    const search = JSON.parse(searchRaw) as { results?: Array<{ thread_id?: string; subject?: string; error?: string }> }
    const topThreadId = search.results?.find((r) => r.thread_id && !r.error)?.thread_id
    if (!topThreadId) return undefined

    const threadRaw = await executeTool('gmail_read_thread', { thread_id: topThreadId })
    const thread = JSON.parse(threadRaw) as {
      messages?: Array<{ from?: string; to?: string; subject?: string; date?: string; body?: string }>
      error?: string
    }
    if (!thread.messages?.length) return undefined

    return thread.messages
      .map((m) => `From: ${m.from || '?'}\nDate: ${m.date || '?'}\nSubject: ${m.subject || '?'}\n${m.body || ''}`)
      .join('\n\n---\n\n')
      .slice(0, 6000) // keep the refine prompt bounded regardless of thread length
  } catch (err) {
    console.error('[narrative-email-context] email lookup failed (non-fatal):', err instanceof Error ? err.message : err)
    return undefined
  }
}
