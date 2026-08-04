/**
 * Workspace recategorization — the standalone P&L tool's twin of
 * `recategorizeAccountYear`, run against `pnl_workspace_transactions`.
 *
 * PARITY: reuses the SAME pure core (`computeRecategorizationUpdates`) as the
 * client path, so a workspace categorizes IDENTICALLY. ISOLATION: writes only
 * to the workspace table; NO rule-learning here, NO attestation — a workspace
 * never touches real client/global state.
 *
 * AI pass (2026-07-02, deliberate design change — was "deterministic by
 * design"): `recategorizeWorkspaceAi` runs the SAME AI-assist policy as the
 * client path (shared `decideAiSuggestion`) on whatever the deterministic
 * passes left uncategorized. It runs via the `recategorize_workspace_ai` job,
 * enqueued by the Generate P&L action — one pass per generation, never on a
 * partial upload set.
 *
 * Rules: a forked workspace loads its linked client's rules + global rules (so
 * it matches the client); a blank workspace loads GLOBAL rules only.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import {
  computeRecategorizationUpdates,
  getCategorizationRules,
  decideAiSuggestion,
  type CategorizableRow,
  type CategorizationRule,
} from "./categorization-engine"
import { aiSuggestCategories, type AiCategorizableTx, type AiCategorizeOptions, type AiSuggestion } from "./ai-categorizer"
import { getExpenseBuckets } from "./expense-buckets"

// Workspace tables are not yet in the generated database.types.ts — same
// untyped-client pattern the categorization engine uses for bank_categorization_rules.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const WS_TX_COLUMNS =
  "id, transaction_date, description, counterparty, amount, currency, balance_after, transaction_ref, bank_name, account_type, account_ref, category, subcategory, is_related_party, notes, ai_lean, ai_bucket, loc_code, loc_source, loc_confidence"

export interface WorkspaceRecategorizeResult {
  scanned: number
  recategorized: number
  transferPairs: number
  uncategorizedRemaining: number
}

/** Every workspace transaction (paged past the 1000-row cap), engine-shaped. */
async function fetchAllWorkspaceTransactions(workspaceId: string): Promise<CategorizableRow[]> {
  return fetchAllPaged<CategorizableRow>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select(WS_TX_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(`Failed to load workspace transactions: ${error.message}`)
    return (data ?? []) as CategorizableRow[]
  })
}

/** Load the rules the workspace should categorize with.
 *  Fork → the linked client's rules + global (identical to the client path).
 *  Blank → global rules + the workspace's OWN learned rules (Phase 4 auto-learn:
 *  staff answers in a blank workspace persist as workspace-scoped rules and
 *  auto-apply on every re-run; they're promoted to the client on Save). */
async function loadRulesForWorkspace(linkedAccountId: string | null, workspaceId?: string): Promise<CategorizationRule[]> {
  if (linkedAccountId) return getCategorizationRules(linkedAccountId)
  const { data, error } = await db
    .from("bank_categorization_rules")
    .select("id, pattern, match_type, category, subcategory, account_id, workspace_id, priority, direction")
    .eq("active", true)
    .is("account_id", null)
    .or(workspaceId ? `workspace_id.is.null,workspace_id.eq.${workspaceId}` : "workspace_id.is.null")
    .order("priority", { ascending: true })
  if (error) throw new Error(`Failed to load workspace categorization rules: ${error.message}`)
  // The engine's applyRules gives precedence to rules with a non-null
  // account_id ("per-client before global"). A workspace-scoped rule must win
  // the same way, so its workspace_id is surfaced AS the account_id marker —
  // ordering-only; these rows never leave this function's result.
  return ((data ?? []) as Array<CategorizationRule & { workspace_id: string | null }>).map(r =>
    r.workspace_id ? { ...r, account_id: r.workspace_id } : r,
  ) as CategorizationRule[]
}

/**
 * Re-categorize one workspace's transactions with the shared deterministic core,
 * persisting only changed rows. Idempotent + re-runnable, exactly like the
 * client path. (The AI-assist pass is separate — `recategorizeWorkspaceAi`,
 * run as a job at Generate time.)
 */
export async function recategorizeWorkspace(
  workspaceId: string,
  opts: { linkedAccountId: string | null; companyName: string; memberNames: string[] },
): Promise<WorkspaceRecategorizeResult> {
  const rows = await fetchAllWorkspaceTransactions(workspaceId)
  if (rows.length === 0) return { scanned: 0, recategorized: 0, transferPairs: 0, uncategorizedRemaining: 0 }

  const rules = await loadRulesForWorkspace(opts.linkedAccountId, workspaceId)
  // Declared related entities (Phase 3R slice 4): forked workspaces inherit
  // the linked client's wizard declarations; blank workspaces have none.
  let relatedEntities: string[] = []
  if (opts.linkedAccountId) {
    const { data: wsRow } = await db.from("pnl_workspaces").select("tax_year").eq("id", workspaceId).maybeSingle()
    if (wsRow?.tax_year) {
      const { fetchDeclaredEntities } = await import("./declared-entities")
      relatedEntities = await fetchDeclaredEntities(db, opts.linkedAccountId, wsRow.tax_year as number)
    }
  }
  const { updates, transferPairs } = computeRecategorizationUpdates(rows, rules, opts.memberNames, opts.companyName, relatedEntities)

  let recategorized = 0
  for (const [id, u] of Array.from(updates.entries())) {
    const orig = rows.find(r => r.id === id)
    if (!orig) continue
    const nextCategory = u.category ?? (orig.category as string)
    const nextSub = u.subcategory ?? ((orig.subcategory as string) ?? "")
    const catChanged = nextCategory !== orig.category || nextSub !== ((orig.subcategory as string) ?? "")
    if (!catChanged && !u.notes && u.ai_lean === undefined && u.ai_bucket === undefined) continue
    const payload: Record<string, unknown> = { category: nextCategory, subcategory: nextSub }
    if (u.notes) payload.notes = u.notes
    if (u.ai_lean !== undefined) payload.ai_lean = u.ai_lean
    if (u.ai_bucket !== undefined) payload.ai_bucket = u.ai_bucket
    const { error } = await db.from("pnl_workspace_transactions").update(payload).eq("id", id)
    if (error) throw new Error(`Failed to update workspace transaction ${id}: ${error.message}`)
    recategorized++
  }

  const uncategorizedRemaining = rows.filter(r => {
    const u = updates.get(r.id as string)
    return (u?.category ?? r.category) === "uncategorized"
  }).length

  // Location labeling (Phase 2b deterministic + S2 guard): stamp loc_* on every
  // row where the inferred location differs from what's stored. Idempotent —
  // the extractors are pure, so re-runs converge; a row that lost its signal
  // (e.g. category became conversion) is cleared back to NULL.
  // S2 clear-guard (review F1): the deterministic extractors are BLIND to what
  // the AI read from language/city tokens — a no-hit here must never wipe an
  // 'ai'-sourced label, or every deterministic re-run erases the AI's work.
  // A fresh deterministic hit still outranks and overwrites 'ai' (deterministic
  // is ground truth); only the CLEAR path skips ai rows.
  const { inferLocation } = await import("./merchant-locations")
  for (const r of rows) {
    const u = updates.get(r.id as string)
    const hit = inferLocation({
      description: (r.description as string | null) ?? null,
      counterparty: (r.counterparty as string | null) ?? null,
      amount: Number(r.amount),
      category: (u?.category ?? r.category) as string | null,
    })
    const cur = r as unknown as { loc_code: string | null; loc_source: string | null; loc_confidence: string | null }
    if (!hit && cur.loc_source === "ai") continue
    const next = hit ?? { loc_code: null, loc_source: null, loc_confidence: null }
    if (cur.loc_code === next.loc_code && cur.loc_source === next.loc_source && cur.loc_confidence === next.loc_confidence) continue
    const { error } = await db.from("pnl_workspace_transactions").update(next).eq("id", r.id)
    if (error) throw new Error(`Failed to stamp location on workspace transaction ${r.id}: ${error.message}`)
  }

  return { scanned: rows.length, recategorized, transferPairs, uncategorizedRemaining }
}

export interface WorkspaceAiResult {
  scanned: number
  aiCategorized: number
  labeled: number
  aiErrors: string[]
  uncategorizedRemaining: number
  /** True when the candidate filter found NOTHING to send — the chain brain
   *  treats this as DONE, never as a no-progress failure. */
  noCandidates?: boolean
  /** Per-run stats for the ai_categorization_runs record (Phase 0.5). */
  stats: import("./ai-categorizer").AiRunStats
  /** High-confidence verdicts applied to GIANT groups (≥100 rows or ≥$10k)
   *  — listed in the per-chunk run record (review F5b: escalation-not-
   *  discovery for the largest blast-radius decisions). */
  giantGroups?: Array<{ merchant: string; count: number; total: number; category: string; confidence: string }>
}

/**
 * AI-assist pass for one workspace — the twin of `recategorizeAccountYear`'s
 * pass 3, byte-identical policy via the shared `decideAiSuggestion`:
 * high-confidence suggestions categorize STILL-UNCATEGORIZED rows only (tagged
 * "ai:high"); every suggestion's lean/bucket lands as advisory hints; rows a
 * human corrected ("manual:" notes) are untouched. Differences from the client
 * path, both structural: context comes from the workspace roster (no
 * tax_return_submissions business description), and it always runs AFTER the
 * deterministic pass has persisted (so categories are read fresh, no in-memory
 * updates map to merge).
 */
export async function recategorizeWorkspaceAi(
  workspaceId: string,
  // businessDescription (v4, review F2): forked workspaces pass the linked
  // client's us_business_activities — the field the expense-vs-cogs pin keys
  // on. Absent (blank workspaces) → the prompt caps that call at 'medium'.
  opts: { companyName: string; memberNames: string[]; businessDescription?: string; aiOptions?: AiCategorizeOptions },
): Promise<WorkspaceAiResult> {
  const rows = await fetchAllWorkspaceTransactions(workspaceId)
  if (rows.length === 0) return { scanned: 0, aiCategorized: 0, labeled: 0, aiErrors: [], uncategorizedRemaining: 0, noCandidates: true, stats: { batchesSent: 0, batchesFailed: 0, suggestionsParsed: 0, truncatedBatches: 0, capped: false } }

  const aiPlaceOn = process.env.AI_PLACE_ENABLED === "1"
  // S2 EXCEPTION (prod incident 2026-07-05): with AI place ON, a still-
  // uncategorized row with hints but NO location is still a candidate — hints
  // predate place-reading, and skipping these locked the whole feature out of
  // any workspace whose rows were hinted before S2 shipped (forks copy hints).
  // ONLY for rows in groups of ≥3 (second prod incident, same day): stamping
  // requires groupSize ≥3, so re-sending singletons for place is pure waste —
  // and because an unstamped row stays a candidate, singletons made the chain
  // re-pay the same front of the list chunk after chunk. Restricting the
  // exception to stampable groups drains the loop: the residual pool fits in
  // one chunk and the chain finishes.
  const { rowRootKey: rootKeyFn, RAIL_SET: railSet } = await import("./row-root")
  const groupSizeByKey = new Map<string, number>()
  if (aiPlaceOn) {
    for (const r of rows) {
      if ((r.category as string) !== "uncategorized") continue
      if ((((r as unknown as { loc_code: string | null }).loc_code) ?? null) !== null) continue
      if (((r.notes as string | null) ?? "").startsWith("manual:")) continue
      const root = rootKeyFn((r.description as string) ?? "", (r.counterparty as string | null) ?? null)
      if (root.source !== "description" || root.degenerate || railSet.has(root.key) || root.key === "(no description)" || Number(r.amount) === 0) continue
      const sign = Number(r.amount) < 0 ? "out" : "in"
      const gk = `${root.key} ${sign} ${(r.currency as string) || "USD"}`
      groupSizeByKey.set(gk, (groupSizeByKey.get(gk) ?? 0) + 1)
    }
  }
  // Candidate selection — same policy as the client path: label outflows booked
  // as a business cost or undecided + inflows booked as income or undecided;
  // skip manual rows and rows that already carry both hints (idempotent + cost).
  const toLabel = rows.filter(r => {
    if (((r.notes as string | null) ?? "").startsWith("manual:")) return false
    const cat = r.category as string
    const hinted = ((r.ai_lean as string | null) ?? null) !== null && ((r.ai_bucket as string | null) ?? null) !== null
    let needsPlace = false
    if (aiPlaceOn && cat === "uncategorized" && (((r as unknown as { loc_code: string | null }).loc_code) ?? null) === null) {
      const root = rootKeyFn((r.description as string) ?? "", (r.counterparty as string | null) ?? null)
      const sign = Number(r.amount) < 0 ? "out" : "in"
      needsPlace = (groupSizeByKey.get(`${root.key} ${sign} ${(r.currency as string) || "USD"}`) ?? 0) >= 3
    }
    if (hinted && !needsPlace) return false
    const amt = Number(r.amount)
    return amt < 0
      ? ["uncategorized", "expense", "fee", "cogs"].includes(cat)
      : ["uncategorized", "income"].includes(cat)
  })
  const uncatBefore = rows.filter(r => (r.category as string) === "uncategorized").length
  if (toLabel.length === 0) return { scanned: rows.length, aiCategorized: 0, labeled: 0, aiErrors: [], uncategorizedRemaining: uncatBefore, noCandidates: true, stats: { batchesSent: 0, batchesFailed: 0, suggestionsParsed: 0, truncatedBatches: 0, capped: false } }

  const bankNames = Array.from(new Set(rows.map(r => (r.bank_name as string) ?? "").filter(Boolean)))
  const rawTxs: AiCategorizableTx[] = toLabel.map(r => ({
    id: r.id as string,
    transaction_date: r.transaction_date as string,
    description: (r.description as string) ?? "",
    counterparty: (r.counterparty as string) ?? "",
    amount: Number(r.amount),
    currency: (r.currency as string) ?? "USD",
    bank_name: (r.bank_name as string) ?? "",
  }))
  // Group-level candidates (Phase 3R-B): one representative line per merchant
  // group (root+direction+currency); the verdict fans out to every member.
  // Dynamiq: ~4,300 rows → ~700 lines → ~18 API calls instead of ~109.
  const { buildGroupedAiCandidates, expandSuggestionMembers, GIANT_GROUP_ROWS, GIANT_GROUP_ABS_TOTAL } =
    await import("./group-ai-candidates")
  const { txs, expansion } = buildGroupedAiCandidates(rawTxs)
  const groupMeta = new Map(txs.filter(t => (t.group_count ?? 1) > 1).map(t => [t.id, t]))
  const buckets = await getExpenseBuckets(db)

  const catById = new Map(rows.map(r => [r.id as string, r.category as string]))
  // Same guard as the client path: the AI must not resolve a row the
  // deterministic passes deliberately refused to guess (see decideAiSuggestion).
  const notesById = new Map(rows.map(r => [r.id as string, (r.notes as string | null) ?? null]))
  let aiCategorized = 0
  let labeled = 0
  const written = new Set<string>()
  const giantGroups: Array<{ merchant: string; count: number; total: number; category: string; confidence: string }> = []

  // S2 (AI place, flag-gated OFF by default until the accuracy gate passes):
  // whitelist = countries with deterministic location evidence in THIS
  // workspace; AI stamps never overwrite deterministic labels; loc_source='ai'
  // rows never create presence periods (period pipeline reads text/map only).
  const aiPlaceEnabled = process.env.AI_PLACE_ENABLED === "1"
  const { decidePlaceStamp } = await import("./ai-place")
  const locRows = rows as unknown as Array<{ id: string; loc_code: string | null; loc_source: string | null }>
  const deterministicCountries: ReadonlySet<string> = new Set(
    locRows
      .filter(r => r.loc_source === "text" || r.loc_source === "map")
      .map(r => r.loc_code ?? "")
      .filter(Boolean),
  )
  const locSourceById = new Map(locRows.map(r => [r.id, r.loc_source ?? null]))

  // Persist one suggestion for ONE member row. TOCTOU guard (re-review COND-3):
  // the category write carries .eq('category','uncategorized') — a Regenerate
  // or a staff answer landing while the AI was thinking must never be
  // overwritten by a verdict decided on stale data. Hint-only writes are
  // additive and unguarded. Group-applied rows get a size-stamped note
  // (ai:high@v3:gN — review F5a) so a challenged group verdict is auditable.
  const persistSuggestion = async (s: AiSuggestion, groupSize = 1, stampPlace?: string) => {
    const d = decideAiSuggestion(s, catById.get(s.id), notesById.get(s.id))
    if (!d.update) return
    const payload: Record<string, unknown> = {}
    if (d.update.category) payload.category = d.update.category
    if (d.update.subcategory !== undefined) payload.subcategory = d.update.subcategory
    if (d.update.notes) payload.notes = groupSize > 1 ? `${d.update.notes}:g${groupSize}` : d.update.notes
    if (d.update.ai_lean !== undefined) payload.ai_lean = d.update.ai_lean
    if (d.update.ai_bucket !== undefined) payload.ai_bucket = d.update.ai_bucket
    // S2: AI place rides the same write — only onto rows with no deterministic
    // label (deterministic always outranks 'ai').
    const curLocSource = locSourceById.get(s.id) ?? null
    if (stampPlace && (curLocSource === null || curLocSource === "ai")) {
      payload.loc_code = stampPlace
      payload.loc_source = "ai"
      payload.loc_confidence = "medium"
    }
    let q = db.from("pnl_workspace_transactions").update(payload).eq("id", s.id)
    if (d.applied) q = q.eq("category", "uncategorized")
    const { error } = await q
    if (error) throw new Error(`Failed to update workspace transaction ${s.id}: ${error.message}`)
    if (d.applied) { aiCategorized++; catById.set(s.id, d.update.category as string) }
    labeled++
    written.add(s.id)
  }

  // Fan one suggestion out to its whole group (review F2): members INCLUDE the
  // representative; already-written members are skipped, so BOTH the per-batch
  // hook and the end-of-run reconcile can call this — a partial fan-out
  // completes without double-writing.
  const persistGroup = async (s: AiSuggestion) => {
    const rep = groupMeta.get(s.id)
    const groupSize = rep?.group_count ?? 1
    const stampPlace = aiPlaceEnabled && s.place &&
      decidePlaceStamp({ place: s.place, groupSize, currency: rep?.currency ?? null, deterministicCountries: deterministicCountries })
      ? s.place
      : undefined
    const memberIds = expandSuggestionMembers(s.id, expansion, written)
    for (const id of memberIds) await persistSuggestion({ ...s, id }, groupSize, stampPlace)
    if (rep && s.confidence === "high" &&
      (groupSize >= GIANT_GROUP_ROWS || Math.abs(rep.group_total ?? 0) >= GIANT_GROUP_ABS_TOTAL)) {
      giantGroups.push({ merchant: rep.description.slice(0, 60), count: groupSize, total: rep.group_total ?? 0, category: s.category, confidence: s.confidence })
    }
  }

  // Per-batch persistence (Phase 0.3): each batch is written before the next
  // API call — a killed run (300s window) keeps everything already paid for.
  const ai = await aiSuggestCategories(
    txs,
    { companyName: opts.companyName || "the company", memberNames: opts.memberNames, businessDescription: opts.businessDescription, bankNames, buckets, grouped: true },
    {
      ...opts.aiOptions,
      onBatch: async (batchSuggestions) => {
        for (const s of batchSuggestions) await persistGroup(s)
      },
    },
  )
  // Reconcile: anything a failed mid-run onBatch write missed — persistGroup
  // skips already-written members, so this completes partial fan-outs only.
  for (const s of ai.suggestions) await persistGroup(s)

  const uncategorizedRemaining = Array.from(catById.values()).filter(c => c === "uncategorized").length
  return { scanned: rows.length, aiCategorized, labeled, aiErrors: ai.errors, uncategorizedRemaining, stats: ai.stats, giantGroups }
}
