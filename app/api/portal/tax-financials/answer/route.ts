/**
 * POST /api/portal/tax-financials/answer
 *   { account_id, tax_year, transaction_ids, answer }
 *
 * The client answers one pattern-grouped question (Slice 8 §3.6) — the answer
 * applies to every transaction in the group. Written with a 'manual:' note so
 * the categorization engine NEVER overwrites a client's answer on re-runs.
 * Only uncategorized rows are touched (the ids are re-filtered server-side).
 *
 * OWNER-ONLY; refused after confirm (post-confirm lock).
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    const transactionIds = Array.isArray(body.transaction_ids) ? body.transaction_ids.map(String) : []
    const answer = String(body.answer ?? '')
    // Bulk mode (multi-group one-tap, 2026-07-05): books rows but NEVER writes
    // learned rules — one lazy sweep must not become permanent per-merchant
    // memory. Distinct notes tag = undo route's guard.
    const isBulk = body.bulk === true
    const groupLabels: string[] = Array.isArray(body.group_labels) ? body.group_labels.map(String).slice(0, 50) : []
    /**
     * ANSWERING THE OWNER QUESTION, not the merchant question.
     *
     * The suspected-member mark is per ROW; the merchant chips answer a whole
     * GROUP. Reusing the chips for it produced wrong tax returns three ways:
     * a partial group booked all its rows, the answer taught a merchant rule
     * that then re-booked every sibling row on the next re-sort (a durable
     * database row no code fix removes), and there was no slot for WHICH owner.
     *
     * So the owner question posts its own shape:
     *  - `suspected: true` — only the flagged ids are sent, and NO rule is
     *    learned, because "this payment was to an owner" says nothing about the
     *    merchant;
     *  - `member` — WHO. Without it a confirmed draw cannot be attributed and
     *    is spread across every partner by ownership %, putting withdrawals on
     *    the K-1 of a partner who received nothing. Written into the note in
     *    the same shape the exact-match path uses, so attribution finds it.
     */
    const isSuspectedAnswer = body.suspected === true
    // The name is written into a note whose grammar uses " | " and "; " as
    // separators — strip those so a crafted value cannot forge extra trailers.
    // Roster names never legitimately contain them.
    const suspectedMember = typeof body.member === 'string' ? body.member.replace(/[|;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : ''

    // Candidates the mark originally named — captured during verification below
    // and written back onto the answer, so the change buttons can still offer
    // the OTHER owner after the mark is consumed (two owners sharing a surname
    // is the card's normal case, and without this a mis-tap was uncorrectable).
    let ownerCandidates: string[] = []
    const buildAnswerNote = () => {
      const base = isBulk ? `manual: bulk client answer (${answer})` : `manual: client answer (${answer})`
      if (!isSuspectedAnswer) return base
      if (!suspectedMember) {
        // "No — a supplier." Keep the candidates on the note anyway: this is
        // the one answer with no path back from the screen (no Member tail →
        // the change block never renders), so the breadcrumb is what lets
        // support see WHO the question was about if the client later disputes
        // it, instead of archaeology. No money reader consumes it — the K-1
        // reader requires the Member tail, which this note does not have.
        return ownerCandidates.length > 0 ? `${base} | Of: ${ownerCandidates.join('; ')}` : base
      }
      const others = ownerCandidates.filter(c => c !== suspectedMember)
      const of = others.length > 0 ? ` | Of: ${ownerCandidates.join('; ')}` : ''
      return `${base} | Member: ${suspectedMember}${of}`
    }

    if (!accountId || !Number.isInteger(taxYear) || transactionIds.length === 0 || !answer) {
      return NextResponse.json({ error: 'account_id, tax_year, transaction_ids and answer required' }, { status: 400 })
    }
    if (transactionIds.length > 2000) {
      return NextResponse.json({ error: 'Too many transactions in one answer.' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { categoryForAnswer } = await import('@/lib/tax/question-groups')
    const mapped = categoryForAnswer(answer)
    if (!mapped) return NextResponse.json({ error: 'Unknown answer choice.' }, { status: 400 })

    // Post-confirm lock — same rule as delete.
    // ONE resolver for which row is the client's file (see resolve-submission.ts):
    // the newest with real data. The old "newest of ANY status" let an unfilled
    // pending/opened form outrank the real submission and unlock it.
    const { resolveEditability } = await import('@/lib/tax/resolve-submission')
    const { editable: canEdit } = await resolveEditability(supabaseAdmin, accountId, taxYear)
    if (!canEdit) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before changing answers.' }, { status: 409 })
    }

    // Override telemetry (Phase 0.5, 2026-07-03): AI-booked rows (notes
    // ai:high@vN) the client is about to re-answer are the PRODUCTION precision
    // meter — captured BEFORE the update overwrites the notes. Chunked ×200: a
    // single .in() with ~950+ ids overflows the PostgREST URL and 500s, and the
    // request cap above is 2000.
    /**
     * THE OWNER QUESTION ONLY ANSWERS PAYMENTS THAT ACTUALLY CARRY THE MARK.
     *
     * The ids come from a screen that may have been open for hours. In between,
     * the nightly re-sort can CLEAR a mark (member removed from the CRM, payee
     * re-identified). Without this check a stale tab books real supplier
     * payments as withdrawals on a named partner's capital account and K-1 —
     * and every gate still ties, because spreading and crediting both preserve
     * the totals. It also fences a future UI edit that passes the whole group's
     * ids instead of the flagged ones: that swap compiles and passes the tests.
     */
    // A RE-ANSWER targets rows the client ALREADY confirmed, which no longer
    // carry the mark (their own answer consumed it). Those are verified by the
    // confirmation marker instead, so changing a mis-tap stays as safe as the
    // first answer: still only rows this client personally decided.
    const isReanswer = body.reanswer === true
    let ownerAnswerIds: string[] = transactionIds
    if (isSuspectedAnswer) {
      const { ASK_CLIENT_NOTE: MARK, CONFIRMED_MEMBER_SEP, suspectedMembersFromNotes, candidatesFromNote } = await import('@/lib/tax/member-names')
      const requiredPrefix = isReanswer ? null : `${MARK}%`
      const marked: string[] = []
      const candidateSet = new Set<string>()
      for (let i = 0; i < transactionIds.length; i += 200) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = await (supabaseAdmin as any)
          .from('bank_transactions')
          .select('id, notes')
          .eq('account_id', accountId)
          .eq('tax_year', taxYear)
          .in('id', transactionIds.slice(i, i + 200))
          .like('notes', requiredPrefix ?? `%${CONFIRMED_MEMBER_SEP}%`)
        for (const r of ((data ?? []) as Array<{ id: string; notes: string | null }>)) {
          marked.push(r.id)
          // First answer: the mark itself names the candidates. Re-answer: the
          // previous answer's breadcrumb carries them forward.
          for (const c of suspectedMembersFromNotes(r.notes)) candidateSet.add(c)
          for (const c of candidatesFromNote(r.notes)) candidateSet.add(c)
        }
      }
      ownerCandidates = Array.from(candidateSet).sort()
      if (marked.length === 0) {
        return NextResponse.json({
          error: isReanswer
            ? 'That answer is no longer on file — please refresh and try again.'
            : 'That question has already been answered or is no longer open — please refresh.',
        }, { status: 409 })
      }
      ownerAnswerIds = marked

      /**
       * AND THE OWNER MUST BE ONE THE K-1 CAN ACTUALLY CREDIT.
       *
       * The roster that RAISES the question (curated members ∪ linked contacts)
       * is deliberately wider than the roster that ALLOCATES money (this year's
       * declared members, with an ownership %). A member who left mid-year, or
       * who is on file but not declared for this year, is offered on the card —
       * and the confirmation then resolves to nobody, so the amount is spread
       * across every remaining partner by ownership %. Withdrawals appear on the
       * K-1 of somebody who received nothing, and the balance sheet still ties,
       * so no gate objects.
       *
       * Refusing is the honest outcome: we say plainly that the member list has
       * to be fixed first, instead of writing an answer we cannot honour.
       */
      if (suspectedMember && mapped.category === 'distribution') {
        const { resolveOwnership, sameName } = await import('@/lib/tax/ownership-resolution')
        // THE CANONICAL WIZARD READER, not a hand-rolled one. The wizard writes
        // FLAT keys (member_0_member_first_name, …, member_count) — the first
        // cut of this guard read `submitted_data.members` as an array, a shape
        // ZERO of the 95 production submissions have, so the whole check was
        // dead code and every un-creditable owner sailed through to be spread
        // across the other partners' K-1s. Same lesson as the roster: never a
        // second definition of "who are the members".
        const { extractWizardMembers } = await import('@/lib/tax/financials-orchestration')
        // THE CANONICAL SUBMISSION RESOLVER — not a hand-rolled status filter.
        // The second cut of this guard read completed-only, which this repo's
        // own resolver documents as the classic bug: most files under review
        // sit at 'reviewed' (43 of 76 real 2025 submissions today), so the
        // guard was dead for the MAJORITY — including the exact moment the
        // re-answer feature exists for, a client correcting an owner answer
        // mid-review. Third hand-rolled reader today; each one was wrong.
        const { resolveClientSubmission } = await import('@/lib/tax/resolve-submission')
        const subData = await resolveClientSubmission<{ submitted_data: Record<string, unknown> | null }>(
          supabaseAdmin, accountId, taxYear, 'submitted_data',
        )
        const wizardMembers = extractWizardMembers(subData?.submitted_data ?? {})
        if (wizardMembers.length > 0) {
          const creditable = resolveOwnership({ priorK1s: [], wizardMembers, accountContacts: [] })
            .members.filter(m => m.pct !== null)
          if (creditable.length > 0 && !creditable.some(m => sameName(m.name, suspectedMember))) {
            return NextResponse.json({
              error: `We can't record this as a payment to ${suspectedMember} yet — they are not on this year's member list. Send us a message and we'll fix the member list first.`,
            }, { status: 409 })
          }
        }
      }
    }

    const aiPre: Array<{ id: string; category: string; notes: string }> = []
    for (let i = 0; i < transactionIds.length; i += 200) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: preAiRows, error: preErr } = await (supabaseAdmin as any)
        .from('bank_transactions')
        .select('id, category, notes')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .in('id', transactionIds.slice(i, i + 200))
        .like('notes', 'ai:high%')
      if (preErr) console.error('[tax-financials] telemetry pre-select failed (answer continues):', preErr.message)
      aiPre.push(...((preAiRows ?? []) as Array<{ id: string; category: string; notes: string }>))
    }

    // Option B (2026-06-18): the owner can re-decide ANY business-booked charge
    // (expense/fee/cogs/income/uncategorized) — and undo a prior client decision
    // (distribution/contribution). We never clobber an auto-detected internal
    // transfer ('conversion') via a merchant flip. 'refund' is re-answerable (a
    // mis-booked refund must be correctable). Chunked ×200; partial-failure
    // contract: attestation reset + telemetry + learning still run for whatever
    // DID change before the error is reported — a stale attestation over
    // changed rows would be worse than the failed chunk.
    const updated: Array<{ id: string; description: string | null; counterparty: string | null; amount: number | string }> = []
    let updateError: string | null = null
    for (let i = 0; i < ownerAnswerIds.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from('bank_transactions')
        // The note carries WHO when the client confirmed an owner. `attributeToMember`
        // needs the member's FULL name in the row text to credit the right partner,
        // and a flagged payment only ever carries a surname — so without this the
        // draw lands in "unattributed" and is spread across every partner by
        // ownership %, and the totals still tie so no gate notices.
        .update({ category: mapped.category, subcategory: mapped.subcategory, notes: buildAnswerNote() })
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        // Bulk only books rows still awaiting a decision — never stomps prior
        // bookings (keeps undo exact: prior state uniformly 'uncategorized').
        .in('category', isBulk ? ['uncategorized'] : ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution', 'refund'])
        .in('id', ownerAnswerIds.slice(i, i + 200))
        .select('id, description, counterparty, amount')
      if (error) { updateError = error.message; break }
      updated.push(...((data ?? []) as typeof updated))
    }

    const changed = updated.length
    if (changed > 0) {
      // Override telemetry write (fire-and-forget): only when the answer CHANGED
      // an AI-applied category — same-category confirmations are agreement.
      const updatedIds = new Set((updated ?? []).map(u => (u as { id: string }).id))
      const changedOverrides = aiPre.filter(o => updatedIds.has(o.id) && o.category !== mapped.category)
      if (changedOverrides.length > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any).from('action_log').insert({
            actor: user.email ?? 'client',
            action_type: 'ai_categorization_override',
            table_name: 'bank_transactions',
            record_id: accountId,
            account_id: accountId,
            summary: `Client answer changed ${changedOverrides.length} AI-booked row(s): ${changedOverrides[0].category} → ${mapped.category} (${changedOverrides[0].notes})`,
            details: { tax_year: taxYear, count: changedOverrides.length, from_categories: changedOverrides.map(o => o.category), to_category: mapped.category, ai_versions: Array.from(new Set(changedOverrides.map(o => o.notes))) },
          })
        } catch (e) {
          console.error('[tax-financials] override telemetry failed (answer saved fine):', e)
        }
      }

      // The data changed — a prior attestation no longer covers it (QA finding).
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `answer applied to ${changed} transactions`)

      // Bulk audit trail (fire-and-forget).
      if (isBulk) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any).from('action_log').insert({
            actor: user.email ?? 'client',
            action_type: 'bulk_group_answer',
            table_name: 'bank_transactions',
            record_id: accountId,
            account_id: accountId,
            summary: `Client bulk answer: ${changed} row(s) booked as ${mapped.category} across ${groupLabels.length || 'several'} group(s)`,
            details: { tax_year: taxYear, answer, count: changed, group_labels: groupLabels },
          })
        } catch (e) {
          console.error('[tax-financials] bulk audit log failed (answer saved fine):', e)
        }
      }

      // LEARN a per-client rule from this answer so the same merchant
      // auto-categorizes next year / on re-runs (the engine applies per-client
      // rules before global ones). Fire-and-forget: a learning failure must
      // NEVER break the client's answer. NEVER on bulk: permanent per-merchant
      // memory requires a per-merchant decision, not a sweep.
      // NEVER learn from the owner question. It answers who a PAYMENT went to,
      // not what a MERCHANT is — and a learned rule keyed on the merchant root
      // would re-book every sibling row on the next re-sort, permanently.
      if (!isBulk && !isSuspectedAnswer) try {
        const { upsertLearnedMerchantRules, makeSupabaseRuleStore } = await import('@/lib/tax/learned-rules')
        await upsertLearnedMerchantRules(
          makeSupabaseRuleStore(supabaseAdmin),
          accountId,
          (updated ?? []) as Array<{ description: string | null; counterparty: string | null; amount: number | string }>,
          mapped.category,
          mapped.subcategory,
          user.email ?? 'client',
        )
      } catch (learnErr) {
        console.error('[tax-financials] learn-rule failed (non-fatal):', learnErr)
      }
    }

    if (updateError) {
      // Post-steps already ran for the rows that DID change; report honestly.
      console.error('[tax-financials] answer partially failed:', updateError)
      return NextResponse.json(
        { error: `Saved ${changed} of ${transactionIds.length} transactions — please retry to finish the rest.`, updated: changed },
        { status: 500 },
      )
    }
    return NextResponse.json({ updated: changed })
  } catch (err) {
    console.error('[tax-financials] answer failed:', err)
    return NextResponse.json({ error: 'Could not save your answer — please try again.' }, { status: 500 })
  }
}
