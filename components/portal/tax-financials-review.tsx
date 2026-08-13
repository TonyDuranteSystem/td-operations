'use client'

/**
 * Tax financials review screen (Slice 8). Renders the on-demand financials
 * view: gate checkmarks, P&L + Balance Sheet summary, per-member capital,
 * per-file cards (delete & replace), pattern-grouped questions, Excel
 * download, and the confirm attestation (blocked while gate 6 fails).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { groupKeyRoot } from '@/lib/tax/question-groups'
import { resolveInstitution } from '@/lib/tax/bank-identity'
import { diagnosisCopy } from '@/lib/tax/ingest-diagnosis'
import { suggestedPhrase, gateSixText } from '@/lib/tax/disclosure-text'
import ValidationBreakdownPanel from './validation-breakdown'

/** Prominent processing card (Antonio, 2026-07-03: "hourglass or a timer and
 *  bigger — the client must understand what's going on"). One shared visual
 *  for every background-work state: big animated spinner, plain-words title,
 *  what's happening, and how long it usually takes. */
function ProgressCard({ title, detail, eta }: { title: string; detail: string; eta: string }) {
  return (
    <section className="rounded-2xl border-2 border-blue-300 bg-blue-50 px-6 py-6 flex items-start gap-4">
      <div className="shrink-0 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white">
        <Loader2 className="h-7 w-7 animate-spin" />
      </div>
      <div>
        <p className="text-base font-bold text-blue-950">⏳ {title}</p>
        <p className="text-sm text-blue-900 mt-1">{detail}</p>
        <p className="text-xs font-medium text-blue-700 mt-2">{eta}</p>
      </div>
    </section>
  )
}

interface Gate { id: number; title: string; status: 'pass' | 'na' | 'fail'; detail: string; blocking: boolean }
interface Member { name: string; pct: number; beginning_capital: number; contributions: number; distributions: number; income_share: number; ending_capital: number }
interface QuestionGroup { group_key: string; label: string; count: number; total: number; currency?: string; direction: 'in' | 'out'; transaction_ids: string[]; sample: string; has_auto_paired_leg?: boolean; ai_lean?: 'business' | 'personal' | 'unsure'; ai_bucket?: string; current_category?: string; current_subcategory?: string; suspected_members?: string[]; suspected_count?: number; suspected_ids?: string[]; suspected_by_member?: Record<string, string[]>; confirmed_by_member?: Record<string, string[]>; confirmed_alternatives?: string[] }
interface Bucket { slug: string; label: string }
interface FileCard { source_file_id: string; bank_name: string; count: number; from: string; to: string; file_name?: string | null }
interface AccountOnFile { account_ref: string; bank: string; acct: string; count: number }

interface CoverageQuestion { key: string; bank_key: string; kind: string; months: string[]; question: string; answer: 'no_activity' | 'had_activity' | null }

interface CompletenessItem { code: string; severity: 'warn' | 'info'; amount?: number; detail?: string }
interface CompletenessSummary { items: CompletenessItem[]; can_accept_as_is: boolean }

interface View {
  coverage: { questions: CoverageQuestion[]; unanswered: number; incomplete: number }
  completeness: CompletenessSummary
  draft: {
    // `folded*` (2026-08-03): what the CLIENT-side by-sign policy pulled INTO
    // the totals without the client ever deciding it. `uncategorizedCount` is
    // forced to 0 under that policy, so these are the only fields that can tell
    // the truth on the portal — the screen used to have no way to know.
    pnl: { totalIncome: number; totalCogs: number; grossProfit: number; totalExpenses: number; netIncome: number; totalDistributions: number; totalContributions: number; uncategorizedCount: number; uncategorizedTotal: number; foldedUncategorizedCount: number; foldedUncategorizedIncome: number; foldedUncategorizedExpense: number }
    members: Member[]
    banks?: Array<{ bank_key: string; currency: string; derived_beginning: number | null; reported_ending: number | null; net_movement: number }>
    bank_balances?: {
      banks: Array<{ bank_key: string; opening_usd: number | null; opening_source: string | null; closing_usd: number | null; closing_source: string | null; expected_closing_usd: number | null; delta_usd: number | null; tie: 'ok' | 'mismatch' | 'unverifiable'; provided_conflicts_derived: boolean; missing_fx_rate: boolean }>
      total_opening_usd: number | null
      total_opening_source: 'statements' | 'provided' | null
      missing_openings: string[]
      mismatched_banks: string[]
    } | null
    beginning_cash: number | null
    beginning_cash_source: 'prior_return' | 'statements' | 'provided' | null
    ending_cash: number
    total_assets: number
    total_liabilities: number
    ending_capital_total: number
    fx_translation_adjustment?: number
    balance_sheet_check?: number
    notes: string[]
  }
  gates: Gate[]
  providedBalances?: Array<{ bank_key: string; currency: string; opening_balance: number | null; closing_balance: number | null; source: 'client' | 'staff' }>
  /** Staff workspace only: the stored prior-return answer (case+status). */
  prior_return?: { case: string | null; status: string | null } | null
  /** Staff workspace only: Validation Mode breakdown (same engine pass). */
  validation?: import('./validation-breakdown').ValidationBreakdownView
  canConfirm: boolean
  transactionCount: number
  /** Per-file ingest jobs still running for this account+year. While > 0 the
   *  P&L is incomplete — show "still preparing", not a misleading $0, and block
   *  attestation. */
  ingestPending: number
  /** Statement files that couldn't be read (unreadable/merged or failed). */
  ingestFailed: number
  /** W9 (card 4a39e0fd): live per-file status — filename, state, and for
   *  failed files the plain-language what-happened + how-to-fix. */
  file_statuses?: Array<{ path: string; file_name: string; state: 'pending' | 'succeeded' | 'failed' | 'quarantined'; client_error: string | null; empty?: boolean; diagnosis?: { code: string; found_years?: number[]; expected_year?: number; software?: string } | null }>
  /** The LIVE institution registry (identity build 2026-08-13) — the form
   *  resolves bank-name → identity mode against the catalog, not the seed. */
  institutions?: Array<{ canonical: string; mode: 'account_number' | 'currency' | 'crypto'; matchTerms: string[] }>
  /** W9: staff unlocked the failed-file hard block from the CRM. */
  failedFilesOverridden?: boolean
  /** S1: statement files quarantined pending a one-tap format confirmation (staff). */
  format_proposals?: Array<{ mapping_id: string; file: string; path: string; bank_label: string; ambiguities: string[]; sample: Array<{ date: string; description: string; amount: number; currency: string; account: string }> | null }>
  questions: QuestionGroup[]
  buckets: Bucket[]
  expense_breakdown?: { slug: string; label: string; total: number }[]
  attested: boolean
  files: FileCard[]
  accounts?: AccountOnFile[]
  /** STAFF WORKSPACE ONLY (Antonio, 2026-07-02): null/absent = upload stage —
   *  the tool shows the statement manager + "Generate P&L", no totals. The
   *  portal API never sends these; every use below is gated on isStaff. */
  generated_at?: string | null
  /** Statements were ingested AFTER the last generation — totals are stale. */
  stale?: boolean
  /** Smart-categorization (AI) jobs still running for this workspace. */
  aiPending?: number
  /** Self-healing chain state (Phase 3R): 'running' | 'retry_scheduled' |
   *  'exhausted' | 'idle'. Backoff retries are AUTOMATIC — the UI only
   *  informs; there is deliberately no manual resume control. */
  aiState?: string
  aiNextRetryAt?: number | null
  aiRemaining?: number
  /** Location-period triage (Phase 2b, STAFF WORKSPACE ONLY — the portal API
   *  never sends these; every use below is additionally gated on isStaff). */
  periods?: PresencePeriodView[]
  period_answers?: PeriodAnswerView[]
  /** S3 country-policy cards (staff tool only): every non-residence country
   *  with still-sweepable located spend — one tap books the whole country. */
  country_cards?: CountryCardView[]
  residence_country?: string | null
  residence_on_file?: boolean
  /** Can the client change anything right now? (2026-08-03.) False while the
   *  submission is with our team or already confirmed — every write route
   *  refuses with 409. Sent so the page can SAY so and disable the controls
   *  instead of letting the client tap into a wall. Absent (undefined) on the
   *  staff workspace payload, which is never locked — treated as editable. */
  editable?: boolean
  reviewStatus?: string | null
}

interface CountryCardView {
  loc_code: string
  count: number
  total: number
  merchants: string[]
  keys: string[]
}

// Location-period triage (Phase 2b): a detected presence stretch ("~6 months
// in Italy") the owner answers ONCE — all business / all personal / one-by-one.
interface PresencePeriodView {
  loc_codes: string[]
  primary: string
  start: string
  end: string
  confidence: string
  row_count: number
  dollar_total: number
  sweepable_count: number
  sweepable_total: number
  top_merchants: string[]
  group_keys: string[]
}
interface PeriodAnswerView {
  id: string
  loc_codes: string[]
  period_start: string
  period_end: string
  choice: string
  actor_role: string
  row_count: number
  dollar_total: number
  created_at: string
}

/** Display names for period locations (loc_code → label). */
const LOC_LABELS: Record<string, { en: string; it: string }> = {
  EU: { en: 'Europe', it: 'Europa' }, IT: { en: 'Italy', it: 'Italia' },
  ES: { en: 'Spain', it: 'Spagna' }, PT: { en: 'Portugal', it: 'Portogallo' },
  FR: { en: 'France', it: 'Francia' }, DE: { en: 'Germany', it: 'Germania' },
  AE: { en: 'Dubai / UAE', it: 'Dubai / EAU' }, US: { en: 'United States', it: 'Stati Uniti' },
  GB: { en: 'United Kingdom', it: 'Regno Unito' }, CH: { en: 'Switzerland', it: 'Svizzera' },
  NL: { en: 'Netherlands', it: 'Paesi Bassi' }, AT: { en: 'Austria', it: 'Austria' },
  GR: { en: 'Greece', it: 'Grecia' }, TR: { en: 'Turkey', it: 'Turchia' },
  TH: { en: 'Thailand', it: 'Thailandia' }, GE: { en: 'Georgia', it: 'Georgia' },
}
const locLabel = (code: string, it: boolean) => (LOC_LABELS[code] ? (it ? LOC_LABELS[code].it : LOC_LABELS[code].en) : code)
const periodLabel = (p: { loc_codes: string[]; primary: string }, it: boolean) =>
  p.loc_codes.length > 1
    ? `${locLabel(p.primary, it)} / ${p.loc_codes.filter(c => c !== p.primary).map(c => locLabel(c, it)).join(' / ')}`
    : locLabel(p.primary, it)

// Drill-down (Luca's request): the transactions behind one P&L expense category,
// grouped by merchant, loaded on demand.
interface CategoryTx { id: string; date: string; description: string; amount: number }
interface CategoryMerchant { merchant: string; count: number; total: number; transactions: CategoryTx[] }
interface CategoryDrill { bucket: string; label: string; merchants: CategoryMerchant[]; total: number; total_count: number; truncated: boolean }

// Direction-pure since 2026-07-05: groups are split per direction server-side
// ('mixed' no longer exists), so a money-in card can never offer "Business
// expense". Mirrors ANSWER_CHOICES in lib/tax/question-groups.ts.
const ANSWERS = [
  { value: 'business_expense', directions: ['out'], en: 'Business expense', it: 'Spesa aziendale' },
  { value: 'personal_spending', directions: ['out'], en: 'Personal (owner) spending', it: 'Spesa personale (del socio)' },
  // 2026-07-07 (Dynamiq): wires to a member had no dividend answer.
  { value: 'owner_draw', directions: ['out'], en: 'Owner draw / dividend', it: 'Prelievo del socio / dividendo' },
  { value: 'business_income', directions: ['in'], en: 'Business income / a sale', it: 'Incasso aziendale / vendita' },
  { value: 'owner_money_in', directions: ['in'], en: 'My own money put in', it: 'Soldi miei messi nella società' },
  { value: 'refund', directions: ['in', 'out'], en: 'Refund / money back', it: 'Rimborso / soldi restituiti' },
  // "the COMPANY's own accounts" (2026-08-05, VSV210): the old "my own
  // accounts" wording read as covering the owner's PERSONAL account, and a
  // member deposit answered this way left the books entirely.
  { value: 'own_transfer', directions: ['in', 'out'], en: "Transfer between the company's own accounts", it: 'Trasferimento tra i conti della società' },
  { value: 'bank_fee', directions: ['out'], en: 'Bank / platform fee', it: 'Commissione bancaria' },
]

// Which answer chip is "active" given the row's current bookkeeping category.
// UNDECIDED groups select NOTHING (prod incident 2026-07-04): pre-lighting
// "Business expense" on uncategorized rows made the most natural click — tap
// the highlighted chip to confirm — a permanently DEAD button (selected chips
// are disabled), so a group could never be booked as business expense at all.
// No booking = no selection; every chip stays clickable.
const CATEGORY_TO_ANSWER: Record<string, string> = {
  expense: 'business_expense', cogs: 'business_expense',
  fee: 'bank_fee', distribution: 'personal_spending', income: 'business_income',
  contribution: 'owner_money_in', conversion: 'own_transfer', refund: 'refund',
}
const activeAnswerOf = (g: QuestionGroup): string | null => {
  const cat = g.current_category ?? 'uncategorized'
  if (cat === 'uncategorized') return null
  // Owner draws light their own chip — 'distribution' alone can't tell a
  // member dividend from personal spend (2026-07-07).
  if (cat === 'distribution' && g.current_subcategory === 'member_distribution') return 'owner_draw'
  if (cat === 'contribution' && g.current_subcategory === 'member_contribution') return 'owner_money_in'
  return CATEGORY_TO_ANSWER[cat] ?? null
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDay = (iso: string, it: boolean) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(it ? 'it-IT' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function TaxFinancialsReview({ accountId, taxYear, locale, mode = 'client', apiBase = '/api/portal/tax-financials' }: { accountId: string; taxYear: number; locale: string; mode?: 'staff' | 'client'; apiBase?: string }) {
  const it = locale === 'it'
  // Staff mode (standalone /tools/pnl): same review + categorization + gates +
  // Excel, but the client-only affordances are hidden — the client attestation
  // (staff aren't the client attesting) and the portal-wizard "edit my info"
  // link. Defaults to 'client' so the portal screen is unchanged.
  const isStaff = mode === 'staff'
  // Single base for every backend call: '/api/portal/tax-financials' for the
  // client portal (default — byte-identical to before) OR '/api/tools/pnl/{id}'
  // for the staff workspace tool. The workspace routes are keyed by the {id}
  // path and IGNORE any legacy account_id/tax_year in the query/body, so every
  // call site below works unchanged with only the base swapped.
  const API = apiBase
  const [view, setView] = useState<View | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // WHERE the last failure happened (2026-08-03). The page-level `error` strip
  // renders once near the top; a client answering a question card at the bottom
  // of a 2,500-line page never sees it — Bence Koncz reported "I tried to
  // choose the good option, but nothing happened" while the server was in fact
  // refusing every tap. Failures are now ALSO shown on the card that was
  // tapped, keyed by its group key ('bulk' for the multi-select bar).
  // Keyed by the EXACT group keys that were in the failed request — not by a
  // 'bulk' sentinel plus "is this card ticked" (bug-hunter). With the sentinel,
  // a client who unticked the failed cards and ticked three different ones saw
  // the red refusal jump onto cards that were never part of the failed call.
  const [cardError, setCardError] = useState<{ keys: string[]; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [attestChecked, setAttestChecked] = useState(false)
  const [attested, setAttested] = useState(false)
  const [newBucket, setNewBucket] = useState('')
  // Add-a-statement uploader (wires the existing owner-only /upload endpoint
  // that was built but never connected to UI). Lets the owner add the rest of
  // the year's statements right here, instead of the copy pointing at an
  // uploader that didn't exist.
  const [uploadBank, setUploadBank] = useState('')
  const [uploadKind, setUploadKind] = useState('checking')
  const [uploadAccount, setUploadAccount] = useState('')
  // Escape hatch for an unknown institution that has no single account number
  // (a multi-currency service or crypto we don't recognize) — lets the client
  // skip the required number without getting stuck.
  const [uploadNoAcct, setUploadNoAcct] = useState(false)
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  // Institution identity mode (from the curated seed): banks need an account
  // number; multi-currency / crypto do not. Drives the required field + warning.
  // Resolve against the LIVE registry from the payload when present (staff
  // catalog changes reach the form without a deploy); code seed as fallback.
  const uploadInst = useMemo(
    () => resolveInstitution(uploadBank, view?.institutions?.length ? view.institutions : undefined),
    [uploadBank, view?.institutions],
  )
  const uploadNeedsAccount = uploadBank.trim().length > 0 && uploadInst.mode === 'account_number' && !uploadNoAcct
  // P&L expense-category drill-down (Luca's request, dev_task 1bee0ffe).
  const [openCat, setOpenCat] = useState<string | null>(null)
  // Triage tiers (2026-07-03): which collapsed review sections are open.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set())
  // Money in / Money out collapsibles (Antonio 2026-07-05). Default OPEN while
  // work remains — the Confirm button stays locked until the queue is empty,
  // and a hidden queue turns that into a dead button nobody understands
  // (reviewer condition). Page length is handled by the 10-card cap instead.
  const [closedNeeds, setClosedNeeds] = useState<Set<string>>(new Set())
  const [showAllNeeds, setShowAllNeeds] = useState<Set<string>>(new Set())
  // Location-period triage (Phase 2b): pending confirm dialog + one-by-one filter.
  const [periodConfirm, setPeriodConfirm] = useState<{ period: PresencePeriodView; choice: 'business' | 'personal' } | null>(null)
  // S3: country-policy confirm ("everything in Spain this year → business").
  const [countryConfirm, setCountryConfirm] = useState<{ card: CountryCardView; choice: 'business' | 'personal' } | null>(null)
  // W9 pop-up (card 4a39e0fd, Antonio's UX calls, both rounds): a file that
  // could not be read — or an empty month — must NOT be buried mid-page, BUT
  // the pop-up may only announce files uploaded IN THIS SESSION as their
  // outcome arrives. Round-2 correction: the first cut derived it from all
  // file states, so logging in with an old failed file still on record threw
  // pop-ups in the client's face before they did anything. `watchedPaths` =
  // paths this session uploaded and not yet announced; a pop-up fires exactly
  // once, when a watched path reaches a final state. Pre-existing failures
  // stay in the inline cards + the locked Confirm — visible, not shouting.
  // Each watch records the view-sequence current AT ARM TIME: a final state is
  // only announced from a view loaded AFTER the upload. Round-3 correction —
  // the arm-time render still held the PRE-upload view, so a re-upload of a
  // file with an old failure on record announced the STALE failure instantly,
  // and the next refresh (new attempt pending) swept it away: Antonio's
  // 1-second flash. The real outcome then arrived to a spent watch.
  const [watchedPaths, setWatchedPaths] = useState<Map<string, number>>(new Map())
  const [fileToasts, setFileToasts] = useState<Array<{ path: string; file_name: string; state: 'failed' | 'empty'; client_error: string | null }>>([])
  // Bumped every time load() lands a fresh view — the watches compare against it.
  const [viewSeq, setViewSeq] = useState(0)
  const [periodFilter, setPeriodFilter] = useState<{ label: string; keys: Set<string> } | null>(null)
  // Period-answer failures render INSIDE the period section (2026-07-04:
  // Antonio's rejected taps surfaced only in the far-away top banner — the
  // buttons looked dead; a rejection must be loud where the click happened).
  const [periodError, setPeriodError] = useState<string | null>(null)
  // S2 slice 2 — per-bank balance anchors editor (books mode only).
  const [balDraft, setBalDraft] = useState<Record<string, { opening: string; closing: string }>>({})
  const [balDirty, setBalDirty] = useState(false)
  const [balError, setBalError] = useState<string | null>(null)
  const [balSaved, setBalSaved] = useState(false)
  const [catData, setCatData] = useState<Record<string, CategoryDrill>>({})
  const [catLoading, setCatLoading] = useState<string | null>(null)
  const [catError, setCatError] = useState<string | null>(null)

  /**
   * `background: true` = the 20-second self-refresh that runs while statements
   * are being processed. It must NOT touch the on-screen messages (2026-08-03).
   * It used to clear them, so a refusal the client had just been shown vanished
   * within 20 seconds and the button was back to "doing nothing" — the exact
   * symptom the card-level message was added to cure, reintroduced by timing.
   * A refusal stays TRUE after a background refresh: the save still failed.
   * Every client action clears the messages on its own way in, so they never
   * pile up.
   */
  const load = useCallback(async (background = false) => {
    setLoading(true)
    if (!background) setError(null)
    try {
      const res = await fetch(`${API}?account_id=${accountId}&tax_year=${taxYear}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile caricare i dati — riprova.' : 'Could not load your financials — please try again.'))
      }
      const v: View = await res.json()
      setView(v)
      setViewSeq(s => s + 1) // watches only trust views landed AFTER their arming
      // A reload the CLIENT caused means the screen now reflects the server, so
      // an earlier card-level refusal is stale and must stop shouting. A
      // BACKGROUND reload means nothing of the sort — see the note on `load`.
      if (!background) setCardError(null)
      setAttested(v.attested) // server truth — a data change resets it
      // Balance editor mirrors the server rows; user edits survive reloads only
      // until saved (save → reload → server truth).
      const provided = new Map((v.providedBalances ?? []).map(b => [b.bank_key, b]))
      setBalDraft(Object.fromEntries((v.draft.banks ?? []).map(b => {
        const row = provided.get(b.bank_key)
        return [b.bank_key, {
          opening: row?.opening_balance === null || row?.opening_balance === undefined ? '' : String(row.opening_balance),
          closing: row?.closing_balance === null || row?.closing_balance === undefined ? '' : String(row.closing_balance),
        }]
      })))
      setBalDirty(false)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load your financials — please try again.')
    } finally {
      setLoading(false)
    }
  }, [accountId, taxYear, it, API])

  useEffect(() => { void load() }, [load])

  // While statements are still ingesting in the background (a busy account's
  // full year can take ~45 min of AI extraction), poll so the page fills in on
  // its own — the client doesn't have to guess when to refresh. Stops as soon
  // as nothing is pending. (Only polls when something is actually in flight.)
  useEffect(() => {
    if (!view) return
    const active = view.ingestPending > 0 || (view.aiPending ?? 0) > 0
    // A backoff-waiting chain polls AT the retry time, not every 20s for hours
    // (review F5c) — clamped to [30s, 5min].
    const retryWait = view.aiState === 'retry_scheduled'
      ? Math.min(300_000, Math.max(30_000, (view.aiNextRetryAt ?? Date.now()) - Date.now()))
      : null
    if (!active && retryWait === null) return
    // background: true — this refresh must never wipe a message off the screen.
    const t = setInterval(() => { void load(true) }, active ? 20000 : retryWait!)
    return () => clearInterval(t)
  }, [view, load])

  // W9 pop-up feed: when a WATCHED (this-session) upload reaches its outcome
  // IN A VIEW LOADED AFTER THE ARMING, announce it once. The seq guard is the
  // whole fix for the 1-second flash: the arm-time render still holds the
  // pre-upload view, whose stale states must never be announced. Failures stay
  // until removed/dismissed; empty-month reassurance auto-closes. Quarantined
  // files are OUR job and stay in the calm inline card, never a pop-up.
  useEffect(() => {
    if (watchedPaths.size === 0 || !view?.file_statuses) return
    const eligible = (path: string) => {
      const armSeq = watchedPaths.get(path)
      return armSeq !== undefined && viewSeq > armSeq
    }
    const arrived = view.file_statuses.filter(
      f => eligible(f.path) && (f.state === 'failed' || (f.state === 'succeeded' && f.empty)),
    )
    const settled = view.file_statuses.filter(f => eligible(f.path) && f.state === 'succeeded' && !f.empty)
    if (arrived.length === 0 && settled.length === 0) return
    setWatchedPaths(prev => {
      const n = new Map(prev)
      arrived.forEach(f => n.delete(f.path))
      settled.forEach(f => n.delete(f.path)) // normal success: no pop-up needed
      return n
    })
    if (arrived.length > 0) {
      setFileToasts(prev => [
        ...prev.filter(t => !arrived.some(a => a.path === t.path)),
        ...arrived.map(f => ({
          path: f.path,
          file_name: f.file_name,
          state: (f.state === 'failed' ? 'failed' : 'empty') as 'failed' | 'empty',
          client_error: f.client_error,
        })),
      ])
    }
  }, [view?.file_statuses, watchedPaths, viewSeq])

  // A failure toast also self-clears when its file stops being failed (the
  // client removed it from the inline card, or a retry recovered it).
  useEffect(() => {
    if (fileToasts.length === 0 || !view?.file_statuses) return
    const stillFailed = new Set(view.file_statuses.filter(f => f.state === 'failed').map(f => f.path))
    setFileToasts(prev => prev.filter(t => t.state === 'empty' || stillFailed.has(t.path)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prune on state refresh only
  }, [view?.file_statuses])

  // Empty-month toasts fade on their own — long enough to actually read.
  useEffect(() => {
    if (!fileToasts.some(t => t.state === 'empty')) return
    const t = setTimeout(() => setFileToasts(prev => prev.filter(x => x.state !== 'empty')), 10000)
    return () => clearTimeout(t)
  }, [fileToasts])

  /**
   * THE OWNER QUESTION — answered separately from the merchant chips.
   *
   * It targets ONLY the flagged payments, never the whole group, and it never
   * teaches a merchant rule: "this payment went to an owner" says nothing about
   * the merchant, and a learned rule keyed on the merchant would re-book every
   * sibling payment on the next re-sort — a durable database row no later code
   * change removes. `member` records WHO, without which a confirmed draw is
   * spread across every partner by ownership % and lands on the K-1 of somebody
   * who received nothing.
   */
  const answerOwnerQuestion = async (g: QuestionGroup, value: string, member?: string) => {
    // "Yes — <owner>" answers ONLY the payments flagged for THAT owner. The
    // flat list would credit one partner with another's withdrawals, which is
    // the normal case here: this card appears precisely when two owners share a
    // surname. "No — a supplier" clears every flagged payment on the card.
    const ids = member
      ? (g.suspected_by_member?.[member] ?? [])
      : (g.suspected_ids ?? [])
    if (ids.length === 0) return
    setBusy(g.group_key)
    setCardError(null)
    try {
      const res = await fetch(`${API}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId, tax_year: taxYear,
          transaction_ids: ids, answer: value, suspected: true,
          ...(member ? { member } : {}),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Risposta non salvata — riprova.' : 'Could not save your answer — please try again.'))
      }
      await load()
    } catch (e) {
      setCardError({ keys: [g.group_key], message: e instanceof Error ? e.message : 'Could not save your answer.' })
      // The usual failure here is a STALE CARD (the overnight re-sort cleared
      // or answered the question while the tab sat open) — the server 409s and
      // tells the client to refresh. Do it for them: without this they sit on a
      // card that re-fails on every tap until they find the reload button.
      void load()
    } finally {
      setBusy(null)
    }
  }

  /**
   * The merchant chips answer "what IS this merchant". They must NEVER consume
   * an open owner question: booking a flagged payment with a `manual:` note
   * settles it for ever (no pass will re-raise it), so an owner withdrawal is
   * silently deducted and the client is never asked. Bulk is worse — it sweeps
   * many cards at once and says nothing about owners.
   *
   * The owner question keeps its own buttons; the merchant answer covers
   * everything else on the card.
   */
  const merchantAnswerIds = (g: QuestionGroup) => {
    const flagged = new Set(g.suspected_ids ?? [])
    return flagged.size === 0 ? g.transaction_ids : g.transaction_ids.filter(id => !flagged.has(id))
  }

  /**
   * CHANGE AN ANSWER ALREADY GIVEN. Same shape as the owner question, but the
   * ids come from what the client previously confirmed rather than from an open
   * mark — the mark is consumed the moment they answer.
   *
   * Without this a mis-tap was unrecoverable from the screen: the only control
   * left was a merchant chip, which re-books every payment in the group and
   * writes a permanent merchant rule. Correcting one attribution corrupted
   * twenty other payments.
   */
  const changeOwnerAnswer = async (g: QuestionGroup, was: string, value: string, member?: string) => {
    const ids = g.confirmed_by_member?.[was] ?? []
    if (ids.length === 0) return
    setBusy(g.group_key)
    setCardError(null)
    try {
      const res = await fetch(`${API}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId, tax_year: taxYear,
          transaction_ids: ids, answer: value, suspected: true, reanswer: true,
          ...(member ? { member } : {}),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Modifica non salvata — riprova.' : 'Could not change your answer — please try again.'))
      }
      await load()
    } catch (e) {
      setCardError({ keys: [g.group_key], message: e instanceof Error ? e.message : 'Could not change your answer.' })
      // Same stale-card refresh as the first answer above.
      void load()
    } finally {
      setBusy(null)
    }
  }

  const answer = async (g: QuestionGroup, value: string) => {
    setBusy(g.group_key)
    setCardError(null)
    try {
      const res = await fetch(`${API}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Changing a HUMAN own_transfer answer targets 'conversion' rows the
        // shared filter refuses — the flag routes it through the server-side
        // note verification instead (2026-08-05, VSV210 no-vanish fix).
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, transaction_ids: merchantAnswerIds(g), answer: value, ...(g.current_category === 'conversion' ? { own_transfer_change: true } : {}) }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        // A 409 means the card is stale (rows changed under it) — refresh so
        // the client lands on the current state, same as the owner paths.
        if (res.status === 409) void load()
        throw new Error(d.error || (it ? 'Risposta non salvata — riprova.' : 'Could not save your answer — please try again.'))
      }
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Both places: the top strip (unchanged) AND the card they tapped, so a
      // refusal is visible without scrolling to the top of the page.
      setError(msg)
      setCardError({ keys: [g.group_key], message: msg })
    } finally {
      setBusy(null)
    }
  }

  // Bulk select (Antonio 2026-07-05): pick several groups, book them with ONE
  // tap. Confirm-always + exact undo (both reviewer conditions — the removed
  // "All as:" buttons incident); the server books WITHOUT learned rules.
  const [bulkSel, setBulkSel] = useState<Map<string, QuestionGroup>>(new Map())
  const [bulkConfirm, setBulkConfirm] = useState<string | null>(null) // pending answer value
  const [bulkUndo, setBulkUndo] = useState<{ ids: string[]; count: number } | null>(null)
  // A bulk failure has to be readable WHERE IT HAPPENED (2026-08-03). The
  // confirm dialog is a full-screen overlay, so the page-level strip and the
  // card-level message both render underneath it: the client saw a dialog that
  // simply refused to do anything, and pressed Confirm again. Same pattern the
  // period/country dialogs already use for their own failures.
  const [bulkError, setBulkError] = useState<string | null>(null)
  const bulkDir = bulkSel.size > 0 ? Array.from(bulkSel.values())[0].direction : null
  const toggleBulk = (g: QuestionGroup) => {
    setBulkSel(prev => {
      const n = new Map(prev)
      if (n.has(g.group_key)) n.delete(g.group_key)
      else n.set(g.group_key, g)
      return n
    })
  }
  const confirmBulkAnswer = async () => {
    if (!bulkConfirm || bulkSel.size === 0) return
    const groups = Array.from(bulkSel.values())
    // Bulk never touches an open owner question — see merchantAnswerIds.
    const ids = groups.flatMap(g => merchantAnswerIds(g))
    setBusy('bulk')
    // Clear on entry like answer() and setBucket() do — without this a stale
    // red refusal survived a LATER SUCCESS (bug-hunter). A false "that didn't
    // work" is the same disease this card-level error was added to cure.
    setCardError(null)
    setBulkError(null)
    try {
      const res = await fetch(`${API}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId, tax_year: taxYear, transaction_ids: ids,
          answer: bulkConfirm, bulk: true, group_labels: groups.map(g => g.label),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Risposta non salvata — riprova.' : 'Could not save your answer — please try again.'))
      }
      const d = await res.json().catch(() => ({})) as { updated?: number }
      setBulkUndo({ ids, count: d.updated ?? ids.length })
      setBulkSel(new Map())
      setBulkConfirm(null)
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      // IN the dialog (it covers everything else), and pinned to the selected
      // cards for when they close it. The dialog deliberately STAYS OPEN so the
      // client can read what happened and retry or cancel from the same place.
      setBulkError(msg)
      setCardError({ keys: groups.map(g => g.group_key), message: msg })
    } finally {
      setBusy(null)
    }
  }
  const undoBulkAnswer = async () => {
    if (!bulkUndo) return
    setBusy('bulk-undo')
    try {
      const res = await fetch(`${API}/answer-undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, transaction_ids: bulkUndo.ids }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile annullare — riprova.' : 'Could not undo — please try again.'))
      }
      setBulkUndo(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // S2 slice 2 — save per-bank balance anchors (books mode; POSTs to the fixed
  // portal route regardless of apiBase — the staff workspace tool never renders
  // this panel because it has no account).
  const saveBalances = async () => {
    if (!view?.draft.banks) return
    setBusy('balances')
    setBalError(null)
    setBalSaved(false)
    try {
      const parseNum = (v: string): number | null => {
        const t = v.trim().replace(/\s/g, '')
        if (!t) return null
        // Accept both 1,234.56 and 1.234,56 (Italian) input styles.
        const normalized = /,\d{1,2}$/.test(t) && !t.includes('.')
          ? t.replace(',', '.')
          : t.replace(/,/g, '')
        const n = Number(normalized)
        if (!Number.isFinite(n)) throw new Error(it ? `Valore non valido: "${v}"` : `Invalid number: "${v}"`)
        return n
      }
      const balances = (view.draft.banks ?? []).map(b => ({
        bank_key: b.bank_key,
        currency: b.currency,
        opening_balance: parseNum(balDraft[b.bank_key]?.opening ?? ''),
        closing_balance: parseNum(balDraft[b.bank_key]?.closing ?? ''),
      })).filter(b => b.opening_balance !== null || b.closing_balance !== null)
      if (balances.length === 0) {
        setBalError(it ? 'Inserisci almeno un saldo.' : 'Enter at least one balance.')
        return
      }
      const res = await fetch('/api/portal/tax-financials/balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, balances }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile salvare i saldi — riprova.' : 'Could not save the balances — please try again.'))
      }
      setBalSaved(true)
      await load()
    } catch (e) {
      setBalError(e instanceof Error && e.message ? e.message : (it ? 'Impossibile salvare i saldi — riprova.' : 'Could not save the balances — please try again.'))
    } finally {
      setBusy(null)
    }
  }

  // Location-period sweep: only from the confirm dialog, never one-click. The
  // server recomputes everything and 409s if the data moved (guards i-v in the
  // endpoint) — a 409 here just reloads so the user re-confirms fresh numbers.
  const confirmPeriodAnswer = async () => {
    if (!periodConfirm) return
    const { period: p, choice } = periodConfirm
    setBusy(`period-${p.primary}-${p.start}`)
    try {
      const res = await fetch(`${API}/period-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId, tax_year: taxYear,
          loc_codes: p.loc_codes, period_start: p.start, period_end: p.end, choice,
          expected_row_count: p.sweepable_count, expected_dollar_total: p.sweepable_total,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile registrare il periodo — riprova.' : 'Could not book the period — please try again.'))
      }
      setPeriodConfirm(null)
      setPeriodFilter(null)
      setPeriodError(null)
      await load()
    } catch (e) {
      // Loud, LOCAL failure (R099): the message renders inside the period
      // section, right where the click happened — never only in a distant
      // top-of-page banner.
      setPeriodError(e instanceof Error ? e.message : String(e))
      setPeriodConfirm(null)
      await load() // 409 = numbers moved — re-render fresh so a re-confirm is honest
    } finally {
      setBusy(null)
    }
  }

  // Is the file frozen right now? (2026-08-03.) The server refuses every write
  // while the submission is with our team or already confirmed. Until now the
  // page didn't know, so it rendered live-looking controls that always failed.
  // `editable` is absent on the staff workspace payload (never locked) — only
  // an explicit false means locked.
  const locked = view?.editable === false
  // Every mutating control on this screen is gated on this, not on `busy`
  // alone (2026-08-03, bug-hunter blocker). The first cut disabled only three
  // controls while the banner promised "you can't change anything here" — so
  // Confirm, Upload and Add-category stayed live under a message saying they
  // weren't. `locked` can only ever be true in CLIENT mode (the staff workspace
  // payload never carries `editable`, verified), so applying it broadly cannot
  // lock staff out of their own tool. Deliberately NOT applied to read-only
  // affordances — reloading, expanding a category, opening a section — because
  // the banner also promises the client can still READ everything.
  const busyOrLocked = busy !== null || locked

  /**
   * THE ONE LIST OF WHAT BLOCKS CONFIRM (card 85f6f0b2 Door-1 rule, applied
   * after Antonio hit the false all-clear: the page said "nothing needs your
   * decision" while two unanswered coverage questions silently locked Confirm).
   * The status header and the Confirm button BOTH read this, so they can never
   * again tell the client different stories. Location cards are deliberately
   * NOT here — they are informational (see the residence-default ruling).
   */
  const confirmBlockers = useMemo(() => {
    if (!view) return [] as Array<{ key: string; label: string; labelIt: string }>
    const out: Array<{ key: string; label: string; labelIt: string }> = []
    const openDecisions = view.questions.filter(
      g => (g.current_category ?? 'uncategorized') === 'uncategorized' || g.suspected_ids?.length,
    ).length
    if (openDecisions > 0) out.push({
      key: 'decisions',
      label: `${openDecisions} ${openDecisions === 1 ? 'item needs' : 'items need'} your decision`,
      labelIt: `${openDecisions} ${openDecisions === 1 ? 'voce da decidere' : 'voci da decidere'}`,
    })
    const cov = (view.coverage?.unanswered ?? 0) + (view.coverage?.incomplete ?? 0)
    if (cov > 0) out.push({
      key: 'coverage',
      label: `${cov} ${cov === 1 ? 'question' : 'questions'} about whether your statements cover the whole year`,
      labelIt: `${cov} ${cov === 1 ? 'domanda' : 'domande'} sulla copertura dell'anno`,
    })
    if (view.ingestPending > 0) out.push({
      key: 'reading',
      label: `${view.ingestPending} ${view.ingestPending === 1 ? 'file is' : 'files are'} still being read`,
      labelIt: `${view.ingestPending} file in lettura`,
    })
    if (view.ingestFailed > 0 && !view.failedFilesOverridden) out.push({
      key: 'failed',
      label: `${view.ingestFailed} ${view.ingestFailed === 1 ? 'file' : 'files'} we could not read`,
      labelIt: `${view.ingestFailed} file non leggibili`,
    })
    return out
  }, [view])

  // One merchant-group question card (chips, bucket select, bulk checkbox).
  // COMPONENT-scope since 2026-07-06 so the country/period cards can render it
  // INLINE ("Review one-by-one" opens in the same card — Antonio).
  const renderQuestionCard = (g: QuestionGroup) => {
    const lean = g.ai_lean === 'personal'
      ? { txt: it ? 'Sembra personale' : 'Looks personal', cls: 'text-amber-700 bg-amber-50' }
      : g.ai_lean === 'business'
        ? { txt: it ? 'Sembra aziendale' : 'Looks business', cls: 'text-emerald-700 bg-emerald-50' }
        : { txt: it ? 'Da controllare' : 'Please check', cls: 'text-zinc-500 bg-zinc-100' }
    // Bulk checkbox only on still-undecided groups: bulk never stomps prior
    // bookings (server enforces the same rule). One direction at a time — the
    // action-bar chips must be valid for everything selected.
    const undecided = (g.current_category ?? 'uncategorized') === 'uncategorized'
    const checked = bulkSel.has(g.group_key)
    const dirBlocked = bulkDir !== null && bulkDir !== g.direction && !checked
    return (
      <div key={g.group_key} className={`rounded-lg border bg-white p-3 ${checked ? 'border-blue-400 ring-1 ring-blue-200' : 'border-zinc-200'}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            {undecided && (
              <input
                type="checkbox"
                checked={checked}
                disabled={busyOrLocked || dirBlocked}
                onChange={() => toggleBulk(g)}
                title={dirBlocked ? (it ? 'Prima completa la selezione nell’altra sezione' : 'Finish your selection in the other section first') : (it ? 'Seleziona per rispondere in blocco' : 'Select to answer together')}
                className="h-4 w-4 accent-blue-600 disabled:opacity-40"
              />
            )}
            <div className="text-sm font-medium text-zinc-800">{g.label}</div>
          </div>
          <div className="text-xs text-zinc-500">{g.count}× · {fmt(g.total)}{g.currency && g.currency !== 'USD' ? ` ${g.currency}` : ''}</div>
        </div>
        {/* WHY WE ARE ASKING. Without this the client sees an ordinary card and
            has no idea we suspect their own owner — which was the entire point
            of raising it. The wording is exact on purpose: when only some rows
            in the group match, it says so, because "this may be a payment to
            X" over a ten-row group where two match is a false statement to a
            client about their own company. */}
        {/* THE OWNER QUESTION — its own control, not a merchant chip.
            The merchant chips answer "what IS this merchant"; this answers
            "did this PAYMENT go to an owner". Reusing the chips for it booked
            whole groups on a partial match, taught a merchant rule that
            re-booked every sibling payment, and had no slot for WHICH owner —
            three ways to a wrong K-1. "No" leaves the bookkeeping untouched. */}
        {(g.suspected_count ?? 0) > 0 && g.suspected_members?.length ? (
          <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
            <div className="mb-1.5">
              {(() => {
                const who = g.suspected_members.join(it ? ' o ' : ' or ')
                const partial = (g.suspected_count ?? 0) < g.count
                if (it) {
                  return partial
                    ? `${g.suspected_count} di questi ${g.count} pagamenti riportano il nome di ${who}. Erano pagamenti a un socio?`
                    : `Questo nome somiglia a ${who}. Era un pagamento a un socio?`
                }
                return partial
                  ? `${g.suspected_count} of these ${g.count} payments carry the name ${who}. Was this a payment to an owner?`
                  : `This name looks like ${who}. Was this a payment to an owner?`
              })()}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.suspected_members.map(m => (
                <button
                  key={m}
                  disabled={busyOrLocked}
                  onClick={() => void answerOwnerQuestion(g, 'owner_draw', m)}
                  className="rounded-full border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  {it ? `Sì — ${m}` : `Yes — ${m}`}{(g.suspected_by_member?.[m]?.length ?? 0) < (g.suspected_count ?? 0) ? ` (${g.suspected_by_member?.[m]?.length})` : ''}
                </button>
              ))}
              <button
                disabled={busyOrLocked}
                onClick={() => void answerOwnerQuestion(g, 'business_expense')}
                className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                {it ? 'No — un fornitore' : 'No — a supplier'}
              </button>
            </div>
          </div>
        ) : null}
        {/* ALREADY ANSWERED — still changeable. The mark is consumed the moment
            the client answers, so without this the buttons vanish and a mis-tap
            can only be undone by tapping a merchant chip, which re-books every
            payment on the card and writes a permanent merchant rule. */}
        {Object.entries(g.confirmed_by_member ?? {}).map(([who, ids]) => (
          <div key={who} className="mt-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] leading-snug text-emerald-900">
            <div className="mb-1.5">
              {it
                ? `Hai indicato che ${ids.length === 1 ? 'questo pagamento è' : `${ids.length} di questi pagamenti sono`} andat${ids.length === 1 ? 'o' : 'i'} a ${who}.`
                : `You said ${ids.length === 1 ? 'this payment went' : `${ids.length} of these payments went`} to ${who}.`}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {/* Alternatives = every owner the payment could have gone to:
                  still-open suspects, the recorded original candidates, and
                  anyone else confirmed on the card. Without the recorded
                  candidates, answering "Yes — Gabriele" left NO way to say
                  "it was Matthew" when both were flagged on the same rows —
                  the exact shared-surname case the card exists for. */}
              {Array.from(new Set([
                ...(g.suspected_members ?? []),
                ...(g.confirmed_alternatives ?? []),
                ...Object.keys(g.confirmed_by_member ?? {}),
              ]))
                .filter(m => m !== who)
                .map(m => (
                  <button
                    key={m}
                    disabled={busyOrLocked}
                    onClick={() => void changeOwnerAnswer(g, who, 'owner_draw', m)}
                    className="rounded-full border border-emerald-400 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                  >
                    {it ? `No — era ${m}` : `No — it was ${m}`}
                  </button>
                ))}
              <button
                disabled={busyOrLocked}
                onClick={() => {
                  // ONE-WAY DOOR, so it asks first. Answering "a supplier"
                  // removes the owner question for good — the note loses its
                  // member trail and nothing re-raises it. On a phone this
                  // button sits next to the others; a mis-tap here was the one
                  // answer the client could never take back.
                  const msg = it
                    ? 'Confermi che NON è un pagamento a un socio? Dopo questa scelta la domanda non verrà più mostrata.'
                    : 'Confirm this was NOT a payment to an owner? After this, the question will no longer be shown.'
                  if (!window.confirm(msg)) return
                  void changeOwnerAnswer(g, who, 'business_expense')
                }}
                className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                {it ? 'No — un fornitore' : 'No — a supplier'}
              </button>
            </div>
          </div>
        ))}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${lean.cls}`}>{lean.txt}</span>
          <select
            value={g.ai_bucket ?? ''}
            disabled={busyOrLocked}
            onChange={e => void setBucket(g, e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 disabled:opacity-50"
          >
            <option value="">{it ? '— categoria —' : '— category —'}</option>
            {view?.buckets.map(b => <option key={b.slug} value={b.slug}>{b.label}</option>)}
          </select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400">{it ? 'Impostato come:' : 'Set as:'}</span>
          {visibleAnswers(g).map(a => {
            const selected = a.value === activeAnswerOf(g)
            // Batch-by-intent (Antonio 2026-07-06: "what is the sense to
            // check them if I can't categorize in batch"): when THIS card is
            // among the ticked ones, its chips act on the WHOLE selection —
            // through the same confirm modal. Unticked cards keep
            // single-card behavior.
            const actsOnSelection = checked && bulkSel.size > 1
            return (
              <button
                key={a.value}
                disabled={busyOrLocked || selected}
                onClick={() => { if (actsOnSelection) setBulkConfirm(a.value); else void answer(g, a.value) }}
                aria-pressed={selected}
                className={selected
                  ? 'rounded-full border border-blue-600 bg-blue-600 px-3 py-1 text-xs font-semibold text-white'
                  : 'rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50'}
              >
                {selected ? '✓ ' : ''}{it ? a.it : a.en}{actsOnSelection ? ` (${bulkSel.size})` : ''}
              </button>
            )
          })}
        </div>
        {/* Human-answered "company transfer" cards (2026-08-05, VSV210): these
            used to vanish forever. Now that they are back and changeable, say
            the one thing the mis-tap needs — personal money is NOT a company
            transfer — and warn when the matching opposite leg would stay
            behind (changing only one leg of a real two-leg transfer would
            manufacture income or expense out of thin air). */}
        {(g.current_category ?? '') === 'conversion' && (
          <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11px] leading-snug text-sky-900">
            {g.direction === 'in'
              ? (it
                ? 'Era denaro dal tuo conto personale? Allora non è un trasferimento della società — scegli "Soldi miei messi nella società".'
                : 'Was this money from your personal account? Then it is not a company transfer — choose "My own money put into the company".')
              : (it
                ? 'Registrato come trasferimento tra i conti della società. Se in realtà era un pagamento, scegli la voce corretta qui sopra.'
                : "Booked as a transfer between the company's own accounts. If it was really a payment, pick the correct answer above.")}
            {(g.has_auto_paired_leg
              // Server-detected AUTO partner leg (never in this feed) — OR a
              // sibling human-answered group of the same merchant, opposite
              // direction. Both mean: changing only THIS side leaves the other
              // half of a real transfer behind (bug-hunter major, 2026-08-06).
              || (view?.questions ?? []).some(o => o.group_key !== g.group_key
              && (o.current_category ?? '') === 'conversion'
              && o.direction !== g.direction
              && groupKeyRoot(o.group_key) === groupKeyRoot(g.group_key))) && (
              <span className="mt-1 block font-medium">
                {it
                  ? 'Attenzione: esiste il movimento opposto registrato come trasferimento. Se cambi questo, controlla anche l\'altro lato.'
                  : 'Note: the matching opposite movement is also booked as a transfer. If you change this one, check the other side too.'}
              </span>
            )}
          </div>
        )}
        {/* The refusal, ON the card that was tapped (2026-08-03). Without this
            the only feedback was a strip at the very top of the page, so a
            client working through the queue saw the button do nothing at all. */}
        {cardError?.keys.includes(g.group_key) && (
          <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800">
            {cardError.message}
          </p>
        )}
      </div>
    )
  }

  // "Review one-by-one" opens INSIDE the tapped card (Antonio 2026-07-06) —
  // which country/period card is expanded inline, and its undecided groups.
  const [inlineReview, setInlineReview] = useState<string | null>(null)
  // Re-run confirm (2026-07-06): re-generation is safe but not free (an AI
  // pass may run) — always confirm, never one-click.
  const [rerunConfirm, setRerunConfirm] = useState(false)
  // Validation Mode toggle (V1, staff-only): shows how every number was made.
  const [validationMode, setValidationMode] = useState(false)
  const inlineGroupsFor = (keys: string[] | Set<string>): QuestionGroup[] => {
    const keySet = keys instanceof Set ? keys : new Set(keys)
    return (view?.questions ?? []).filter(g =>
      (g.current_category ?? 'uncategorized') === 'uncategorized' && keySet.has(groupKeyRoot(g.group_key)))
  }
  const renderInlineReview = (cardId: string, keys: string[] | Set<string>) => {
    if (inlineReview !== cardId) return null
    const groups = inlineGroupsFor(keys)
    return (
      <div className="mt-3 space-y-2 border-t border-indigo-200 pt-3">
        {groups.length === 0
          ? <p className="text-xs text-zinc-500">{it ? 'Niente da decidere qui — tutto già registrato.' : 'Nothing left to decide here — everything is booked.'}</p>
          : groups.map(renderQuestionCard)}
      </div>
    )
  }

  // S3: country-policy answer — same endpoint, scope 'country' (server derives
  // the full-year range and includes AI-read locations). Same undo as periods.
  const confirmCountryAnswer = async () => {
    if (!countryConfirm) return
    const { card, choice } = countryConfirm
    setBusy(`country-${card.loc_code}`)
    try {
      const res = await fetch(`${API}/period-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId, tax_year: taxYear,
          scope: 'country', loc_codes: [card.loc_code], choice,
          expected_row_count: card.count, expected_dollar_total: card.total,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile registrare il paese — riprova.' : 'Could not book the country — please try again.'))
      }
      setCountryConfirm(null)
      setPeriodFilter(null)
      setPeriodError(null)
      await load()
    } catch (e) {
      setPeriodError(e instanceof Error ? e.message : String(e))
      setCountryConfirm(null)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const undoPeriodAnswer = async (batchId: string) => {
    setBusy(`period-undo-${batchId}`)
    try {
      const res = await fetch(`${API}/period-answer/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, batch_id: batchId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile annullare — riprova.' : 'Could not undo — please try again.'))
      }
      setPeriodError(null)
      await load()
    } catch (e) {
      setPeriodError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Toggle a category open and lazy-load its transactions (cached after first open).
  const toggleCategory = async (slug: string) => {
    if (openCat === slug) { setOpenCat(null); return }
    setOpenCat(slug)
    setCatError(null)
    if (catData[slug]) return
    setCatLoading(slug)
    try {
      const res = await fetch(`${API}/category-transactions?account_id=${accountId}&tax_year=${taxYear}&bucket=${encodeURIComponent(slug)}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile caricare la categoria — riprova.' : 'Could not load this category — please try again.'))
      }
      const d: CategoryDrill = await res.json()
      setCatData(prev => ({ ...prev, [slug]: d }))
    } catch (e) {
      setCatError(e instanceof Error ? e.message : String(e))
    } finally {
      setCatLoading(null)
    }
  }

  const addBucket = async () => {
    const name = newBucket.trim()
    if (name.length < 2) return
    setBusy('add-bucket')
    try {
      const res = await fetch(`${API}/add-bucket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, name }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile aggiungere la categoria — riprova.' : 'Could not add the category — please try again.'))
      }
      setNewBucket('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // NOTE (2026-07-03): the "All as:" bulk-answer buttons were REMOVED with the
  // triage redesign. An exploratory bulk click silently wrote ~200 binding
  // manual answers on B&P2 (the root-cause incident) — one group answer already
  // covers all of that merchant's rows, and auto-learn propagates it, so the
  // bulk path's value was small and its blast radius huge. If it ever returns,
  // it must carry an explicit confirmation dialog + undo.

  const setBucket = async (g: QuestionGroup, bucket: string) => {
    setBusy(g.group_key)
    setCardError(null)
    try {
      const res = await fetch(`${API}/set-bucket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, transaction_ids: g.transaction_ids, bucket }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile spostare la categoria — riprova.' : 'Could not move the category — please try again.'))
      }
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setCardError({ keys: [g.group_key], message: msg })
    } finally {
      setBusy(null)
    }
  }

  const deleteFile = async (f: FileCard) => {
    const label = f.file_name ? `"${f.file_name}"` : `${f.bank_name}`
    const msg = it
      ? `Eliminare ${label} (${f.count} transazioni)? Potrai caricarne uno nuovo subito dopo.`
      : `Delete ${label} (${f.count} transactions)? You can upload a new one right after.`
    if (!window.confirm(msg)) return
    setBusy(f.source_file_id)
    try {
      const res = await fetch(`${API}/statement?account_id=${accountId}&tax_year=${taxYear}&source_file_id=${encodeURIComponent(f.source_file_id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile eliminare il file — riprova.' : 'Could not delete the file — please try again.'))
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // W9: clear a FAILED file (never produced rows — job-cancel, not row delete).
  const clearFailedFile = async (path: string, fileName: string) => {
    const msg = it
      ? `Rimuovere il file "${fileName}"? Poi carica l'estratto conto corretto.`
      : `Remove the file "${fileName}"? Then upload the corrected statement.`
    if (!window.confirm(msg)) return
    setBusy(path)
    try {
      const res = await fetch(`${API}/statement?account_id=${accountId}&tax_year=${taxYear}&failed_path=${encodeURIComponent(path)}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile rimuovere il file — riprova.' : 'Could not remove the file — please try again.'))
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Upload one statement file; throws on failure with the server's message.
  const uploadOneStatement = async (file: File, bank: string, account: string): Promise<void> => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('account_id', accountId)
    fd.append('tax_year', String(taxYear))
    fd.append('bank_name', bank)
    fd.append('account_kind', uploadKind)
    fd.append('account_number', account)
    // The client's explicit "no single account number" choice travels to the
    // server, so the server-side required-number gate knows the difference
    // between "skipped" and "genuinely has no number" (multi-currency/crypto).
    if (uploadNoAcct) fd.append('no_account_number', '1')
    const res = await fetch(`${API}/upload`, { method: 'POST', body: fd })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(d.error || (it ? 'Caricamento non riuscito — riprova.' : 'Upload failed — please try again.'))
    }
    // Watch THIS upload so its outcome (failed / empty month) pops up once —
    // only files from this session ever pop; old failures stay inline (W9
    // round 2: login must never open onto a wall of pop-ups). The stored seq
    // is the view shown WHEN the upload happened — outcomes only count from
    // views loaded after it (round 3: the stale-flash fix).
    if (typeof d.path === 'string' && d.path) {
      setWatchedPaths(prev => new Map(prev).set(d.path, viewSeq))
    }
  }

  // Upload one or more files SEQUENTIALLY (one at a time), refreshing the P&L
  // after each so the numbers grow as files land. Per-file failures are
  // collected and surfaced without aborting the rest of the batch.
  const uploadStatements = async (files: File[]) => {
    const bank = uploadBank.trim()
    const account = uploadAccount.trim()
    if (!bank) { setError(it ? 'Indica il nome della banca prima di caricare.' : 'Enter the bank name before uploading.'); return }
    if (uploadNeedsAccount && !account) {
      setError(it
        ? 'Inserisci il numero di conto di questa banca prima di caricare — serve per non confondere due conti diversi.'
        : 'Enter this bank\'s account number before uploading — it\'s what keeps two different accounts apart.')
      return
    }
    // RE-ECHO (plan §B, Antonio's rule): the typed number is read BACK to the
    // client before anything uploads — a typo here silently splits one real
    // account into two, so the number is confirmed, not just typed.
    if (uploadNeedsAccount && account) {
      const echo = it
        ? `Confermi il numero di conto?\n\n${uploadInst.canonical} — conto ${account}\n\nSe è sbagliato, il tuo P&L sarà sbagliato.`
        : `Confirm the account number?\n\n${uploadInst.canonical} — account ${account}\n\nIf it's wrong, your P&L will be wrong.`
      if (!window.confirm(echo)) return
    }
    if (files.length === 0) return
    setError(null)
    setUploadNote(null)
    setBusy('upload')
    let ok = 0
    const failures: string[] = []
    try {
      for (let i = 0; i < files.length; i++) {
        setUploadNote(it ? `Caricamento ${i + 1} di ${files.length}…` : `Uploading ${i + 1} of ${files.length}…`)
        try {
          await uploadOneStatement(files[i], bank, account)
          ok++
          await load()
        } catch (e) {
          failures.push(`${files[i].name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setUploadBank('')
      setUploadAccount('')
      setUploadNoAcct(false)
      setUploadNote(
        (it
          ? `✓ ${ok} di ${files.length} file ricevuti — stiamo leggendo le transazioni, i numeri compaiono tra poco.`
          : `✓ ${ok} of ${files.length} file(s) received — we're reading the transactions now; your numbers will appear shortly.`)
        + (failures.length ? (it ? ` ${failures.length} non riusciti.` : ` ${failures.length} failed.`) : ''),
      )
      if (failures.length) setError(failures.join(' · '))
    } finally {
      setBusy(null)
    }
  }

  const answerCoverage = async (q: CoverageQuestion, value: 'no_activity' | 'had_activity') => {
    setBusy(q.key)
    try {
      const res = await fetch(`${API}/coverage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, question_key: q.key, answer: value }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Risposta non salvata — riprova.' : 'Could not save your answer — please try again.'))
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Plain-English (EN/IT) rendering of a completeness code → what it means +
  // what would make it complete. Driven off the server's machine codes so the
  // i18n lives in one place (the gate text itself stays technical/internal).
  const completenessText = (item: CompletenessItem): string => {
    const amt = item.amount !== undefined ? fmt(Math.abs(item.amount)) : ''
    switch (item.code) {
      case 'reconciliation_gap':
        return it
          ? 'Uno dei tuoi estratti conto non torna — di solito mancano dei mesi o l\'export è stato filtrato. Ricaricare l\'intero anno renderebbe il dato esatto.'
          : 'One of your statements doesn\'t add up — usually some months are missing or the export was filtered. Re-uploading the full year would make it exact.'
      case 'no_prior_year':
        return it
          ? 'Non abbiamo la dichiarazione dell\'anno scorso, quindi i saldi iniziali di quest\'anno provengono dai tuoi estratti conto. Se ce l\'hai, condividerla collegherebbe i due anni.'
          : 'We don\'t have last year\'s tax return, so this year\'s opening balances come from your bank statements. If you have it, sharing it would tie the two years together.'
      case 'balance_sheet_off':
        return it
          ? `Lo stato patrimoniale non quadra per $${amt} — di solito un conto mancante, dei mesi mancanti, o denaro tenuto in un'altra valuta o conto che non vediamo.`
          : `Your balance sheet is off by $${amt} — usually a missing account, missing months, or money held in another currency or account we don't see.`
      case 'capital_rollforward':
        return it
          ? 'I conti capitale dei soci non quadrano ancora del tutto — lo sistemiamo noi in fase di revisione.'
          : 'The owners\' capital accounts don\'t fully tie out yet — we\'ll finish this during review.'
      case 'ownership_incomplete':
        return it
          ? 'Ci serve ancora la percentuale di proprietà di ogni socio per ripartire i K-1.'
          : 'We still need each owner\'s ownership percentage to split the K-1s.'
      case 'unattributed_owner_moves':
        return it
          ? `Abbiamo trovato $${amt} di movimenti dei soci (entrate/uscite) che non siamo riusciti ad attribuire a un socio per nome — li abbiamo ripartiti per percentuale. Diccelo se è importante per te.`
          : `We found $${amt} of owner money in/out we couldn't match to a specific owner by name — we split it by ownership %. Tell us who if it matters to you.`
      case 'missing_fx_rate':
        return it
          ? `Non abbiamo un tasso di cambio ufficiale per ${item.detail} (${taxYear}), quindi quegli importi sono mostrati nella valuta originale. Aggiungiamo il tasso noi in revisione.`
          : `We don't have an official exchange rate on file for ${item.detail} (${taxYear}), so those amounts are shown in their original currency. We'll add the rate during review.`
      default:
        return item.detail ?? ''
    }
  }

  const attest = async () => {
    setBusy('attest')
    try {
      const res = await fetch(`${API}/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Conferma non registrata — riprova.' : 'Could not record your confirmation — please try again.'))
      }
      setAttested(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Staff workspace only: stamp the workspace as generated (or re-generated
  // after new uploads) — the server refuses while files are still processing.
  const generate = async () => {
    setBusy('generate')
    setError(null)
    try {
      const res = await fetch(`${API}/generate`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not generate — please try again.')
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Staff workspace only (2026-07-06): set/clear the prior-return answer —
  // first-year companies can never produce a prior return; the server
  // cross-checks first_year against the linked client's formation date.
  // S1: resolve a quarantined statement format (staff one-tap).
  const resolveFormat = async (mappingId: string, path: string, action: 'confirm' | 'reject') => {
    setBusy(`format-${action}-${mappingId}`)
    setError(null)
    try {
      const res = await fetch(`${API}/confirm-format`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping_id: mappingId, path, action }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save the format decision — please try again.')
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const setPriorReturn = async (choice: 'first_year' | 'never_filed' | 'clear') => {
    setBusy(`prior-return-${choice}`)
    setError(null)
    try {
      const res = await fetch(`${API}/prior-return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save the prior-return answer — please try again.')
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const gateIcon = (g: Gate) => g.status === 'pass' ? '✓' : g.status === 'na' ? '—' : '!'
  const gateColor = (g: Gate) => g.status === 'pass' ? 'text-emerald-600 bg-emerald-50' : g.status === 'na' ? 'text-zinc-500 bg-zinc-100' : 'text-amber-700 bg-amber-50'

  const visibleAnswers = useMemo(() => (g: QuestionGroup) => ANSWERS.filter(a => a.directions.includes(g.direction)), [])

  // Strong, deliberate warning against PDF uploads (Antonio, 2026-06-26).
  // PDFs are read by AI extraction — slow (minutes/file, hours for a full
  // year) and lossy. CSV is fast and reliable, and every bank offers it.
  const pdfWarning = (
    <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 sm:p-5 flex gap-3">
      <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-white text-2xl font-black leading-none">!</div>
      <div className="text-sm text-red-900">
        <p className="font-bold">
          {it ? 'Caricare PDF NON è consigliato.' : 'Uploading PDFs is NOT recommended.'}
        </p>
        <p className="mt-1 text-red-800">
          {it
            ? 'Qualsiasi commercialista o sistema impiega ore per estrarre i dati da un PDF, e alcune transazioni possono andare perse. Consigliamo vivamente di caricare solo file CSV — è più facile e sicuro per tutti, e TUTTE le banche permettono di scaricare i CSV. Non avere fretta in questo passaggio: è il tuo Conto Economico e Stato Patrimoniale, un passaggio importante per la tua LLC.'
            : 'Any CPA or system takes hours to extract the data from a PDF, and transactions can be lost. We strongly recommend uploading CSV files only — it\'s easier and safer for everyone, and ALL banks let you download CSV. Don\'t rush this step: it\'s your Profit & Loss and Balance Sheet, an important step for your LLC.'}
        </p>
      </div>
    </div>
  )

  // Bank statements list + "Add a statement" uploader. Extracted so it can
  // render both in the normal populated view AND in the empty state (no
  // transactions yet) without duplicating markup.
  // S1: quarantined-format confirmation card — the file will NOT be read until
  // staff confirms how its columns should be interpreted (never guess).
  const renderFormatProposals = () => {
    if (!isStaff || !view?.format_proposals?.length) return null
    return (
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 sm:p-5 space-y-4">
        <div>
          <h2 className="text-sm font-bold text-amber-900">⚠ {view.format_proposals.length} file(s) need a format confirmation</h2>
          <p className="text-xs text-amber-800 mt-0.5">We can read these files, but one detail is ambiguous — confirm the proposed reading below or reject it and request a proper bank export. The file is NOT counted until you decide.</p>
        </div>
        {view.format_proposals.map(fp => (
          <div key={fp.mapping_id} className="rounded-lg border border-amber-200 bg-white p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-zinc-800">{fp.file} <span className="text-zinc-400">· read as {fp.bank_label}</span></span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={busyOrLocked}
                  onClick={() => void resolveFormat(fp.mapping_id, fp.path, 'confirm')}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy === `format-confirm-${fp.mapping_id}` ? 'Confirming…' : 'Confirm — read it this way'}
                </button>
                <button
                  type="button"
                  disabled={busyOrLocked}
                  onClick={() => void resolveFormat(fp.mapping_id, fp.path, 'reject')}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                >
                  {busy === `format-reject-${fp.mapping_id}` ? 'Rejecting…' : 'Reject'}
                </button>
              </span>
            </div>
            {fp.ambiguities.length > 0 && (
              <ul className="text-xs text-amber-800 list-disc pl-4">
                {fp.ambiguities.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
            {Array.isArray(fp.sample) && fp.sample.length > 0 && (
              <table className="w-full text-xs text-zinc-600">
                <thead><tr className="text-zinc-400 text-left"><th className="font-normal">Date</th><th className="font-normal">Description</th><th className="font-normal text-right">Amount</th><th className="font-normal">Currency</th><th className="font-normal">Account</th></tr></thead>
                <tbody>
                  {fp.sample.map((s, i) => (
                    <tr key={i}><td>{s.date}</td><td className="pr-2">{s.description}</td><td className="text-right">{s.amount.toFixed(2)}</td><td>{s.currency}</td><td>{s.account}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </section>
    )
  }

  const renderStatements = () => {
    if (!view) return null
    return (
      <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'Estratti conto' : 'Bank statements'}</h2>
        {view.files.length > 0 && (
          <ul className="space-y-2 mb-4">
            {view.files.map(f => (
              <li key={f.source_file_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2">
                <div className="min-w-0 text-sm text-zinc-800">
                  <span className="font-medium">{f.bank_name}</span>
                  {/* The uploaded file's own name — without it, fourteen Relay
                      lines are indistinguishable and Delete is a coin flip. */}
                  {f.file_name && <span className="ml-2 break-all text-xs text-zinc-600">{f.file_name}</span>}
                  <span className="text-zinc-500 text-xs ml-2">{f.count} {it ? 'transazioni' : 'transactions'} · {f.from} → {f.to}</span>
                </div>
                <button
                  disabled={busyOrLocked}
                  onClick={() => void deleteFile(f)}
                  className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {it ? 'Elimina' : 'Delete'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* W9 (card 4a39e0fd): live per-file status — every in-flight, failed
            or quarantined file gets its own named card; never a naked spinner,
            never a bare error. Succeeded files render above as source cards. */}
        {(view.file_statuses ?? []).filter(f => f.state !== 'succeeded' || f.empty).length > 0 && (
          <ul className="space-y-2 mb-4">
            {(view.file_statuses ?? []).filter(f => f.state !== 'succeeded' || f.empty).map(f => (
              <li
                key={f.path}
                className={`rounded-lg border px-3 py-2 ${
                  f.state === 'failed' ? 'border-red-200 bg-red-50/60' : f.state === 'quarantined' ? 'border-sky-200 bg-sky-50/60' : 'border-zinc-200 bg-zinc-50/60'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-zinc-800 min-w-0">
                    <span className="font-medium break-all">{f.file_name}</span>
                    <span className={`text-xs ml-2 ${f.state === 'failed' ? 'text-red-700' : f.state === 'quarantined' ? 'text-sky-700' : 'text-zinc-500'}`}>
                      {f.state === 'pending' && (it ? 'Lettura in corso…' : 'Reading…')}
                      {f.state === 'quarantined' && (it ? 'Formato in verifica dal nostro team — nessuna azione richiesta' : 'Format being confirmed by our team — nothing needed from you')}
                      {f.state === 'failed' && (
                        f.diagnosis?.code === 'wrong_year'
                          ? (it ? 'Anno sbagliato' : 'Wrong year')
                          : f.diagnosis?.code === 'not_bank_statement'
                            ? (it ? 'Non è un estratto conto' : 'Not a bank statement')
                            : (it ? 'Non leggibile' : 'Could not be read')
                      )}
                      {f.state === 'succeeded' && f.empty && (it ? 'Letto correttamente — nessuna transazione nel periodo (mese senza attività)' : 'Read correctly — no transactions in its period (a month with no activity)')}
                    </span>
                  </div>
                  {f.state === 'failed' && (
                    <button
                      disabled={busyOrLocked}
                      onClick={() => void clearFailedFile(f.path, f.file_name)}
                      className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                    >
                      {it ? 'Rimuovi questo file' : 'Remove this file'}
                    </button>
                  )}
                </div>
                {/* Wave 2 (Antonio): the card says WHAT is wrong + the fix, in
                    the client's language, from the ONE copy source the chat
                    message also uses (lib/tax/ingest-diagnosis.ts). Legacy
                    failures without a diagnosis keep the stored guide text. */}
                {f.state === 'failed' && (
                  <p className="mt-1 text-xs text-red-700">
                    {f.diagnosis ? diagnosisCopy(f.diagnosis as never)[it ? 'it' : 'en'] : f.client_error}
                  </p>
                )}
                {f.state === 'failed' && !f.diagnosis && (
                  <p className="mt-1 text-xs text-zinc-600">
                    {it
                      ? 'Rimuovi il file e carica l\'estratto conto corretto (CSV o PDF ufficiale della banca). Il nostro team è già stato avvisato.'
                      : 'Remove the file and upload the corrected statement (your bank\'s official CSV or PDF). Our team has already been notified.'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {pdfWarning}
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 p-3 sm:p-4">
          <div className="text-sm font-medium text-zinc-800">{it ? 'Aggiungi gli estratti conto' : 'Add statements'}</div>
          <p className="text-xs text-zinc-500 mt-1">
            {it
              ? 'Scegli il conto, poi seleziona uno o più file CSV di quella banca per l\'intero anno. Non unire o modificare i file — caricali separati, uno per banca.'
              : 'Pick the account, then select one or more CSV files for that bank\'s full year. Don\'t merge or edit the files — upload them separately, one per bank.'}
          </p>
          {(view.accounts?.length ?? 0) > 0 && (
            <div className="mt-2">
              <div className="text-xs text-zinc-500">
                {/* Card e1cb2b44: the old parenthetical promised "no retyping
                    the number" — false for accounts saved without one (the
                    chip filled the bank and left the number empty next to a
                    red warning). The promise now matches reality: chips WITH
                    a number restore it; numberless ones just fill the bank. */}
                {it ? 'I tuoi conti già caricati — tocca per riusare lo stesso:' : 'Your accounts on file — tap to reuse the same one:'}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {view.accounts!.map(a => (
                  <button
                    key={a.account_ref}
                    type="button"
                    disabled={busyOrLocked}
                    onClick={() => { setUploadBank(a.bank); setUploadAccount(a.acct); setUploadNoAcct(false) }}
                    className="rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-xs text-zinc-700 hover:border-zinc-900 disabled:opacity-50"
                  >
                    {a.acct ? `${a.bank} ••${a.acct}` : a.bank}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={uploadBank}
              onChange={e => setUploadBank(e.target.value)}
              placeholder={it ? 'Nome della banca (es. Mercury)' : 'Bank name (e.g. Mercury)'}
              disabled={busyOrLocked}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50"
            />
            {uploadNeedsAccount && (
              <input
                value={uploadAccount}
                onChange={e => setUploadAccount(e.target.value)}
                placeholder={it ? 'Numero di conto (o ultime 4 cifre)' : 'Account number (or last 4 digits)'}
                disabled={busyOrLocked}
                className="rounded-md border border-red-400 px-2 py-1 text-xs disabled:opacity-50"
              />
            )}
            <select
              value={uploadKind}
              onChange={e => setUploadKind(e.target.value)}
              disabled={busyOrLocked}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 disabled:opacity-50"
            >
              <option value="checking">{it ? 'Conto corrente' : 'Checking'}</option>
              <option value="savings">{it ? 'Conto risparmio' : 'Savings'}</option>
              <option value="credit_card">{it ? 'Carta di credito' : 'Credit card'}</option>
            </select>
            <label className={`rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 ${busy !== null ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
              {busy === 'upload' ? (it ? 'Caricamento…' : 'Uploading…') : (it ? 'Scegli file' : 'Choose files')}
              <input
                type="file"
                accept=".csv,.pdf,.zip"
                multiple
                disabled={busyOrLocked}
                className="hidden"
                onChange={e => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (files.length) void uploadStatements(files)
                }}
              />
            </label>
          </div>
          {uploadNeedsAccount && (
            <div className="mt-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700">
              {it
                ? '⚠️ Ricontrolla il numero di conto dopo averlo scritto — se è sbagliato, il tuo P&L sarà sbagliato.'
                : '⚠️ Double-check the account number after you type it — if it\'s wrong, your P&L will be wrong.'}
            </div>
          )}
          {uploadBank.trim().length > 0 && !uploadInst.matched && (
            <label className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={uploadNoAcct}
                onChange={e => setUploadNoAcct(e.target.checked)}
                disabled={busyOrLocked}
              />
              {it
                ? 'È un servizio multivaluta o crypto (senza numero di conto unico)'
                : 'This is a multi-currency service or crypto (no single account number)'}
            </label>
          )}
          {uploadNote && <div className="mt-2 text-xs text-emerald-700">{uploadNote}</div>}
        </div>
      </section>
    )
  }

  if (loading && !view) return <div className="py-16 text-center text-zinc-500 text-sm">{it ? 'Calcolo dei tuoi numeri…' : 'Computing your numbers…'}</div>

  // ── STAFF WORKSPACE, UPLOAD STAGE (Antonio, 2026-07-02) ──
  // Until "Generate P&L" is pressed, the tool is a statement manager: upload
  // every bank's files first (they parse in the background), then generate
  // once. No totals are rendered here — a partial P&L mid-upload is exactly
  // the failure mode that produced the B&P $594k number. STRICTLY staff-gated:
  // the portal API never sends generated_at, and the client flow is unchanged.
  if (isStaff && view && !view.generated_at) {
    const processing = view.ingestPending > 0
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
            Upload bank statements — {taxYear}
          </h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">
            Upload ALL the company&apos;s statements (every bank, every account), then press <strong>Generate P&amp;L</strong>. Files are read in the background while you keep uploading.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
        )}

        {renderFormatProposals()}
        {renderStatements()}

        <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm flex-1">
            {processing ? (
              <ProgressCard
                title="Almost ready — we're reading your statements"
                detail={`${view.ingestPending} file(s) are still being read and prepared. You can keep uploading more statements meanwhile; the Generate button unlocks by itself when everything is ready.`}
                eta="Usually 2–5 minutes per batch. This page refreshes on its own."
              />
            ) : view.transactionCount > 0 ? (
              <span className="text-zinc-700">{view.files.length} statement(s) ready · {view.transactionCount} transactions loaded.</span>
            ) : (
              <span className="text-zinc-500">No statements loaded yet.</span>
            )}
            {view.ingestFailed > 0 && (
              <span className="block text-xs text-red-700 mt-1">
                {it
                  ? `${view.ingestFailed} file non leggibile/i — vedi le schede file sopra per la soluzione. La conferma resta bloccata finché non è risolto (il nostro team è avvisato).`
                  : `${view.ingestFailed} file(s) could not be read — see the file cards above for how to fix each one. Confirmation stays locked until this is resolved (our team has been notified).`}
              </span>
            )}
          </div>
          <button
            type="button"
            disabled={busyOrLocked || processing || view.transactionCount === 0}
            onClick={() => void generate()}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'generate' ? 'Generating…' : 'Generate P&L'}
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* W9 POP-UP (card 4a39e0fd): a failed / empty file surfaces here, fixed
          at the top of the viewport so it can't be lost mid-page. It is DERIVED
          from the live file states — it disappears the instant the file is
          removed or re-read correctly; empty-month notices also auto-close. */}
      {fileToasts.length > 0 && (
        <div className="fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3 pointer-events-none" aria-live="assertive">
          {fileToasts.map(f => {
            const failed = f.state === 'failed'
            return (
              <div
                key={f.path}
                role={failed ? 'alert' : 'status'}
                className={`pointer-events-auto w-full max-w-xl rounded-xl border shadow-lg p-4 ${
                  failed ? 'border-red-300 bg-red-50' : 'border-emerald-300 bg-emerald-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${failed ? 'text-red-800' : 'text-emerald-800'}`}>
                      {failed
                        ? (it ? `Non siamo riusciti a leggere “${f.file_name}”` : `We couldn't read “${f.file_name}”`)
                        : (it ? `“${f.file_name}” letto correttamente` : `“${f.file_name}” read correctly`)}
                    </p>
                    <p className={`mt-1 text-xs ${failed ? 'text-red-700' : 'text-emerald-700'}`}>
                      {failed
                        ? (f.client_error ?? (it ? 'Rimuovi il file e carica l’estratto conto corretto.' : 'Remove the file and upload the corrected statement.'))
                        : (it ? 'Nessuna transazione nel periodo (un mese senza attività). Nessuna azione richiesta.' : 'No transactions in its period (a month with no activity). Nothing needed from you.')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {failed && (
                      <button
                        onClick={() => void clearFailedFile(f.path, f.file_name)}
                        disabled={busyOrLocked}
                        className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {it ? 'Rimuovi' : 'Remove'}
                      </button>
                    )}
                    <button
                      onClick={() => setFileToasts(prev => prev.filter(x => x.path !== f.path))}
                      aria-label={it ? 'Chiudi' : 'Dismiss'}
                      className={`rounded-md px-2 py-1 text-sm ${failed ? 'text-red-500 hover:text-red-700' : 'text-emerald-600 hover:text-emerald-800'}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
            {it ? `Conto Economico e Stato Patrimoniale ${taxYear}` : `Profit & Loss and Balance Sheet ${taxYear}`}
          </h1>
          {/* Always-visible re-run (2026-07-06, Antonio) — same guarded
              /generate machinery as the first run: deterministic pass +
              AI chain if anything is open. Human answers are immune by
              design; ships together with the zero-amount oscillation fix. */}
          {isStaff && (
            <span className="flex gap-2">
              {view.validation && (
                <button
                  type="button"
                  onClick={() => setValidationMode(v => !v)}
                  aria-pressed={validationMode}
                  className={`rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${validationMode
                    ? 'border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'border-zinc-300 bg-white text-zinc-700 hover:border-indigo-400 hover:text-indigo-700'}`}
                >
                  🔍 Validation mode
                </button>
              )}
              <button
                type="button"
                disabled={busyOrLocked}
                onClick={() => setRerunConfirm(true)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50"
              >
                {busy === 'generate' ? 'Re-running…' : '↻ Re-run P&L'}
              </button>
            </span>
          )}
        </div>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {it
            ? 'Preparati da noi sui tuoi estratti conto — controlla, rispondi alle domande rimaste e conferma.'
            : 'Prepared by us from your bank statements — check them, answer what remains, and confirm.'}
        </p>
        {!isStaff && (
          <p className="text-xs text-zinc-500 mt-2">
            {it ? 'Hai sbagliato qualcosa che hai inserito? ' : 'Made a mistake in something you entered? '}
            <a href="/portal/wizard?type=tax" className="font-semibold text-blue-700 underline hover:text-blue-900">
              {it ? 'Modifica le tue informazioni' : 'Edit my information'}
            </a>
            {it ? '. Le tue risposte e le categorie già scelte restano salvate.' : '. Your answers and the categories you already chose stay saved.'}
          </p>
        )}
      </div>

      {/* Validation Mode (V1, staff-only) — rendered FIRST so toggling it
          shows the explanation immediately, no scrolling (Antonio 2026-07-07).
          Same engine pass as the report, invariant-checked. */}
      {isStaff && validationMode && view.validation && (
        <ValidationBreakdownPanel validation={view.validation} api={API} />
      )}

      {/* Frozen file (2026-08-03) — say it BEFORE they tap, not after. Every
          control below is disabled to match, so nobody spends an afternoon
          pressing buttons that the server was always going to refuse. */}
      {locked && (
        <section role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4">
          <p className="text-sm font-semibold text-amber-900">
            {it
              ? 'Il tuo questionario è al momento con il nostro team — per ora non puoi modificare nulla qui.'
              : 'Your file is with our team right now — you can\'t change anything here for the moment.'}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {it
              ? 'Puoi comunque leggere tutti i numeri qui sotto. Scrivici in chat e lo riapriamo subito.'
              : 'You can still read every number below. Message us in the chat and we\'ll reopen it right away.'}
          </p>
        </section>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* Staff workspace: statements were added AFTER the last generation —
          the totals below no longer reflect the data. Ask to regenerate. */}
      {isStaff && view?.stale && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-amber-900">New statements were added after the last generation — these totals are OUT OF DATE.</p>
            <p className="text-xs text-amber-800 mt-1">Regenerate to include the new data before reading or downloading anything.</p>
          </div>
          <button
            type="button"
            disabled={busyOrLocked || view.ingestPending > 0}
            onClick={() => void generate()}
            className="shrink-0 inline-flex items-center rounded-md bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {busy === 'generate' ? 'Regenerating…' : view.ingestPending > 0 ? `Waiting for ${view.ingestPending} file(s)…` : 'Regenerate P&L'}
          </button>
        </section>
      )}

      {/* Ingestion still running with nothing landed yet — show a clear
          "preparing" state instead of a misleading all-zeros P&L. The page
          polls itself (effect above) and fills in as jobs finish. */}
      {view && view.ingestPending > 0 && view.transactionCount === 0 && (
        <>
          <ProgressCard
            title={it ? 'Stiamo preparando i tuoi prospetti…' : 'We\'re preparing your statements…'}
            detail={it
              ? `Stiamo leggendo i tuoi estratti conto (${view.ingestPending} in elaborazione) e classificando ogni transazione. I numeri compariranno qui da soli.`
              : `We're reading your bank statements (${view.ingestPending} still processing) and classifying every transaction. Your numbers will appear here on their own.`}
            eta={it
              ? 'Per un anno intero può richiedere fino a 30–45 minuti. Questa pagina si aggiorna da sola — puoi lasciarla aperta o tornare più tardi.'
              : 'For a full year this can take up to 30–45 minutes. This page refreshes on its own — you can leave it open or come back later.'}
          />
          {view.ingestFailed > 0 && (
            <p className="text-xs text-amber-700 mt-2">
              {it
                ? `${view.ingestFailed} file non è stato leggibile — controlla i file qui sotto quando l'elaborazione è finita.`
                : `${view.ingestFailed} file couldn't be read — check your files below once processing finishes.`}
            </p>
          )}
        </>
      )}

      {/* Client-visible, TEXT-ONLY (Phase 3R): a paused/stopped AI chain must
          be visible — never look finished — but the client gets no control;
          recovery is automatic and staff is alerted on exhaustion. */}
      {!isStaff && view && (view.aiState === 'retry_scheduled' || view.aiState === 'exhausted') && (
        <p className="text-xs text-zinc-500 mt-2">
          {it
            ? 'Stiamo ancora completando la classificazione automatica delle tue transazioni — nessuna azione richiesta da parte tua.'
            : 'We\'re still finishing the automatic classification of your transactions — no action needed from you.'}
        </p>
      )}

      {/* Some statements already landed but MORE are still processing — the P&L
          below is INCOMPLETE. The multi-bank case: the old condition
          (transactionCount === 0) hid this signal the moment the first file
          landed, so a partial P&L looked final and a just-uploaded file looked
          like it "didn't run" (B&P multi-bank, 2026-07-01). Keep the signal
          visible whenever anything is in flight, and offer a manual refresh so
          staff aren't blind between the 20s poll / the safety-net cron. */}
      {view && view.ingestPending > 0 && view.transactionCount > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              {it
                ? `${view.ingestPending} estratto/i ancora in elaborazione — il prospetto qui sotto è INCOMPLETO`
                : `${view.ingestPending} more statement(s) still processing — the P&L below is INCOMPLETE`}
            </p>
            <p className="text-xs text-amber-800 mt-1 max-w-xl">
              {it
                ? 'Carica tutti gli estratti conto (ogni banca) prima di scaricare o confermare, e aspetta che finiscano. La pagina si aggiorna da sola ogni 20 secondi.'
                : 'Upload all the bank statements (every bank) before you download or confirm, and wait for them to finish. This page refreshes on its own every 20 seconds.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            /* Reload only — writes nothing, so it stays available while the file
               is locked (the banner promises the client can still read). */
            disabled={busy !== null}
            className="shrink-0 inline-flex items-center rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {it ? 'Aggiorna' : 'Check now'}
          </button>
        </section>
      )}

      {/* No statements yet (and nothing processing) — show an empty state with
          the uploader instead of a misleading all-zeros P&L. This is the case
          a client hits right after the form is submitted but before any
          statement has been uploaded/ingested (Luca / B&P, 2026-06-26). */}
      {view && view.transactionCount === 0 && view.ingestPending === 0 && (
        <div className="space-y-6">
          <section className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-6 text-center">
            <p className="text-sm font-semibold text-amber-900">
              {view.ingestFailed > 0
                ? (it ? 'Non siamo riusciti a leggere i tuoi estratti conto' : 'We couldn\'t read your bank statements')
                : (it ? 'Non abbiamo ancora i tuoi estratti conto' : 'We don\'t have your bank statements yet')}
            </p>
            <p className="text-xs text-amber-800 mt-1.5 max-w-md mx-auto">
              {view.ingestFailed > 0
                ? (it
                    ? `${view.ingestFailed} file non è stato leggibile. Elimina il file qui sotto e ricarica l'export dell'intero anno (CSV o PDF ufficiale).`
                    : `${view.ingestFailed} file couldn't be read. Delete it below and re-upload the full-year export (CSV or official PDF).`)
                : (it
                    ? 'Carica gli estratti conto dell\'intero anno qui sotto e prepareremo il tuo Conto Economico e Stato Patrimoniale.'
                    : 'Upload your full-year bank statements below and we\'ll prepare your Profit & Loss and Balance Sheet.')}
            </p>
          </section>
          {renderFormatProposals()}
          {renderStatements()}
        </div>
      )}

      {view && view.transactionCount > 0 && (
        <>
          {/* Some statements still processing, but partial data is showing —
              be honest that the numbers aren't final yet. */}
          {view.ingestPending > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              {it
                ? `Ancora ${view.ingestPending} estratto/i conto in elaborazione — i numeri qui sotto sono parziali e si aggiorneranno da soli. Non confermare finché non abbiamo finito.`
                : `${view.ingestPending} statement(s) still processing — the numbers below are partial and will update on their own. Please don't confirm until we're done.`}
            </div>
          )}
          {/* Staff workspace: the smart-categorization pass is still running —
              the question list / categories below will improve on their own. */}
          {isStaff && (view.aiPending ?? 0) > 0 && (
            <ProgressCard
              title="Smart categorization is working…"
              detail="The AI is reading each remaining transaction's full description and booking the ones it is confident about. Anything it isn't sure of will be flagged for you — never guessed. The numbers below will improve on their own."
              eta="Large workspaces continue automatically across several rounds. This page refreshes by itself — you can keep working."
            />
          )}
          {/* Self-healing chain (Phase 3R): a paused chain retries BY ITSELF on
              a backoff ladder — no button, nothing to check. Only a spent
              ladder shows the staff-attention line (support already emailed). */}
          {isStaff && (view.aiPending ?? 0) === 0 && view.aiState === 'retry_scheduled' && (
            <ProgressCard
              title="Smart categorization continues automatically…"
              detail={`${view.aiRemaining ?? 0} transactions still to process. The last round hit a temporary problem — the system retries on its own${view.aiNextRetryAt ? ` (next attempt ~${new Date(view.aiNextRetryAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : ''}. Nothing to do here.`}
              eta="Retries are automatic; support is alerted if it can't finish by itself."
            />
          )}
          {isStaff && view.aiState === 'exhausted' && (
            <section className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3">
              <p className="text-sm text-amber-900">
                ⚠ Smart categorization needs staff attention ({view.aiRemaining ?? 0} rows unprocessed after all automatic retries) — <strong>support has been notified by email</strong>. Once the cause is fixed, Regenerate restarts it.
              </p>
            </section>
          )}

          {/* Staff workspace: unclassified money is EXCLUDED from the totals
              (never silently folded into income — the B&P $594k lesson). Say
              it loudly and point at the questions list below. */}
          {isStaff && view.draft.pnl.uncategorizedCount > 0 && (
            <section className="rounded-xl border-2 border-red-300 bg-red-50 px-5 py-4">
              <p className="text-sm font-bold text-red-900">
                ⚠ {view.draft.pnl.uncategorizedCount} transaction(s) (net {fmt(view.draft.pnl.uncategorizedTotal)}) are UNCLASSIFIED — excluded from these totals.
              </p>
              <p className="text-xs text-red-800 mt-1">
                The P&amp;L and Balance Sheet below are incomplete until every transaction is categorized. Answer the questions in the review list below — do not download or save to a client before that.
              </p>
            </section>
          )}

          {/* Gates */}
          <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'Verifiche' : 'Verifications'}</h2>
            <ul className="space-y-2">
              {view.gates.map(g => (
                <li key={g.id} className="flex items-start gap-3">
                  <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${gateColor(g)}`}>{gateIcon(g)}</span>
                  <div>
                    <div className="text-sm font-medium text-zinc-800">
                      {g.id === 6 ? (it ? 'Ogni transazione decisa da te' : 'Every transaction categorized') : g.title}
                    </div>
                    {/* Gate 6 is rendered from the client's own numbers so it
                        speaks their language; every other gate still shows the
                        module's (English) detail — pre-existing, flagged. */}
                    <div className="text-xs text-zinc-500">
                      {g.id === 6 ? gateSixText(view.draft.pnl, it) : g.detail}
                    </div>
                    {/* Gate 2 staff control (2026-07-06): a first-year company can
                        never produce a prior return — answer it here instead of
                        the gate nagging forever. Hidden over extracted returns
                        (endpoint enforces the same). */}
                    {isStaff && g.id === 2 && (!view.prior_return || view.prior_return.status === 'failed') && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busyOrLocked}
                          onClick={() => void setPriorReturn('first_year')}
                          className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50"
                        >
                          {busy === 'prior-return-first_year' ? 'Saving…' : 'First year — no prior return'}
                        </button>
                        <button
                          type="button"
                          disabled={busyOrLocked}
                          onClick={() => void setPriorReturn('never_filed')}
                          className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50"
                        >
                          {busy === 'prior-return-never_filed' ? 'Saving…' : 'No prior return was ever filed'}
                        </button>
                      </div>
                    )}
                    {isStaff && g.id === 2 && (view.prior_return?.case === 'first_year' || view.prior_return?.case === 'never_filed') && (
                      <button
                        type="button"
                        disabled={busyOrLocked}
                        onClick={() => void setPriorReturn('clear')}
                        className="mt-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-500 hover:border-red-300 hover:text-red-600 disabled:opacity-50"
                      >
                        {busy === 'prior-return-clear' ? 'Clearing…' : 'Clear this answer'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* P&L + Balance Sheet */}
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'Conto Economico' : 'Profit & Loss'}</h2>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Ricavi' : 'Revenue'}</dt><dd className="font-medium">{fmt(view.draft.pnl.totalIncome)}</dd></div>
                {view.draft.pnl.totalCogs !== 0 && <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Costo del venduto' : 'Cost of goods sold'}</dt><dd className="font-medium">−{fmt(view.draft.pnl.totalCogs)}</dd></div>}
                {view.draft.pnl.totalCogs !== 0 && <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Margine lordo' : 'Gross profit'}</dt><dd className="font-medium">{fmt(view.draft.pnl.grossProfit)}</dd></div>}
                <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Spese operative' : 'Operating expenses'}</dt><dd className="font-medium">−{fmt(view.draft.pnl.totalExpenses)}</dd></div>
                {(view.expense_breakdown?.length ?? 0) > 0 && (
                  <div className="pl-3 border-l border-zinc-100 ml-1 space-y-0.5">
                    {view.expense_breakdown!.map(b => {
                      const open = openCat === b.slug
                      const drill = catData[b.slug]
                      return (
                        <div key={b.slug}>
                          <button
                            type="button"
                            onClick={() => toggleCategory(b.slug)}
                            className="flex w-full items-center justify-between gap-2 text-xs text-zinc-500 hover:text-zinc-800 py-0.5"
                            aria-expanded={open}
                          >
                            <span className="flex items-center gap-1 text-left">
                              <span className={`inline-block transition-transform text-[9px] text-zinc-400 ${open ? 'rotate-90' : ''}`}>▶</span>
                              {b.label}
                            </span>
                            <span>−{fmt(b.total)}</span>
                          </button>
                          {open && (
                            <div className="ml-3 mt-1 mb-2 border-l border-zinc-100 pl-3">
                              {catLoading === b.slug && (
                                <p className="text-xs text-zinc-400 py-1">{it ? 'Caricamento…' : 'Loading…'}</p>
                              )}
                              {catError && catLoading !== b.slug && !drill && (
                                <p className="text-xs text-red-600 py-1">{catError}</p>
                              )}
                              {drill && (
                                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                                  {drill.merchants.length === 0 && (
                                    <p className="text-xs text-zinc-400">{it ? 'Nessuna transazione.' : 'No transactions.'}</p>
                                  )}
                                  {drill.merchants.map((m, mi) => (
                                    <div key={`${m.merchant}-${mi}`}>
                                      <div className="flex justify-between gap-2 text-xs font-medium text-zinc-600">
                                        <span className="truncate">{m.merchant}</span>
                                        <span className="shrink-0 text-zinc-500">{m.count}× · −{fmt(m.total)}</span>
                                      </div>
                                      <div className="mt-0.5 space-y-0.5">
                                        {m.transactions.map(t => (
                                          <div key={t.id} className="flex justify-between gap-2 text-[11px] text-zinc-400">
                                            <span className="truncate">{t.date} · {t.description}</span>
                                            <span className="shrink-0">−{fmt(t.amount)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                  {drill.truncated && (
                                    <p className="text-[11px] text-zinc-400 italic">
                                      {it
                                        ? `Mostrate le prime transazioni di ${drill.total_count} totali.`
                                        : `Showing the first transactions of ${drill.total_count} total.`}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex justify-between border-t border-zinc-100 pt-1.5"><dt className="font-semibold text-zinc-900">{it ? 'Utile netto' : 'Net income'}</dt><dd className="font-semibold">{fmt(view.draft.pnl.netIncome)}</dd></div>
                {isStaff && view.draft.pnl.uncategorizedCount > 0 && (
                  <div className="flex justify-between text-red-700">
                    <dt className="font-medium">⚠ Unclassified — excluded ({view.draft.pnl.uncategorizedCount})</dt>
                    <dd className="font-medium">{fmt(view.draft.pnl.uncategorizedTotal)}</dd>
                  </div>
                )}
                {/* How much of the figures above is still OURS, not theirs
                    (2026-08-03). The client draft folds every undecided row
                    into the expense lines under the category WE suggested, so
                    a line like "Groceries & Retail −86,712" silently mixed the
                    client's own answers with our guesses — and the panel above
                    used to tick "all categorized" on top of it. This names the
                    provisional amount without moving a single number, so the
                    totals still add up and the client can see what is at stake
                    if they confirm now. */}
                {view.draft.pnl.foldedUncategorizedCount > 0 && (
                  <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2">
                    <div className="flex justify-between text-amber-900">
                      <dt className="font-semibold">
                        {it
                          ? `Di cui ancora un nostro suggerimento (${view.draft.pnl.foldedUncategorizedCount})`
                          : `Of which still our suggestion (${view.draft.pnl.foldedUncategorizedCount})`}
                      </dt>
                    </div>
                    {/* BOTH SIDES (bug-hunter blocker, 2026-08-03). The first cut
                        printed only foldedUncategorizedExpense with a hardcoded
                        minus and called them "expenses" — so a client whose
                        undecided rows are INFLOWS (unidentified incoming wires /
                        payout batches, the commonest shape here) was shown
                        "(12) −0.00" while gate 6 on the same screen said
                        +120,000. Income and expense are now separate lines, each
                        rendered only when it exists, so the disclosure can never
                        contradict the gate again. */}
                    {view.draft.pnl.foldedUncategorizedExpense !== 0 && (
                      <div className="flex justify-between text-amber-900">
                        <dt>{it ? 'Uscite' : 'Money out'}</dt>
                        <dd className="font-semibold">−{fmt(view.draft.pnl.foldedUncategorizedExpense)}</dd>
                      </div>
                    )}
                    {view.draft.pnl.foldedUncategorizedIncome !== 0 && (
                      <div className="flex justify-between text-amber-900">
                        <dt>{it ? 'Entrate' : 'Money in'}</dt>
                        <dd className="font-semibold">{fmt(view.draft.pnl.foldedUncategorizedIncome)}</dd>
                      </div>
                    )}
                    <p className="mt-1 text-[11px] leading-snug text-amber-800">
                      {it
                        ? 'Questi movimenti sono già inclusi nei totali qui sopra, ma li abbiamo classificati noi al posto tuo. Rispondi alle domande più in basso per renderli tuoi.'
                        : 'These movements are already inside the totals above, but we classified them for you. Answer the questions further down to make them yours.'}
                    </p>
                  </div>
                )}
                {view.draft.pnl.totalDistributions !== 0 && <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Prelievi dei soci' : 'Owner distributions'}</dt><dd className="font-medium">−{fmt(view.draft.pnl.totalDistributions)}</dd></div>}
                {view.draft.pnl.totalContributions !== 0 && <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Apporti dei soci' : 'Owner contributions'}</dt><dd className="font-medium">{fmt(view.draft.pnl.totalContributions)}</dd></div>}
              </dl>
            </section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'Stato Patrimoniale' : 'Balance Sheet'}</h2>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-zinc-500">
                    {it ? 'Cassa iniziale' : 'Beginning cash'}
                    {view.draft.beginning_cash_source === 'statements' && (
                      <span className="ml-1 text-[11px] text-zinc-400">{it ? '(dai tuoi estratti conto)' : '(from your statements)'}</span>
                    )}
                    {view.draft.beginning_cash_source === 'provided' && (
                      <span className="ml-1 text-[11px] text-zinc-400">{it ? '(dai saldi che hai fornito)' : '(per the balances you provided)'}</span>
                    )}
                  </dt>
                  <dd className="font-medium">{view.draft.beginning_cash === null ? '—' : fmt(view.draft.beginning_cash)}</dd>
                </div>
                <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Cassa finale' : 'Ending cash'}</dt><dd className="font-medium">{fmt(view.draft.ending_cash)}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Totale attivo' : 'Total assets'}</dt><dd className="font-medium">{fmt(view.draft.total_assets)}</dd></div>
                {isStaff && view.draft.pnl.uncategorizedCount > 0 && (
                  <div className="flex justify-between text-red-700">
                    <dt className="font-medium">⚠ Unclassified cash movement — categorize to balance</dt>
                    <dd className="font-medium">{fmt(view.draft.pnl.uncategorizedTotal)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-zinc-100 pt-1.5"><dt className="font-semibold text-zinc-900">{it ? 'Capitale soci' : 'Members’ capital'}</dt><dd className="font-semibold">{fmt(view.draft.ending_capital_total)}</dd></div>
                {Math.abs(view.draft.fx_translation_adjustment ?? 0) > 0.01 && (
                  <div className="flex justify-between">
                    <dt className="text-zinc-500">
                      {it ? 'Rettifica di conversione valutaria' : 'Foreign-exchange translation adjustment'}
                      <span className="ml-1 text-[11px] text-zinc-400">{it ? '(non è reddito)' : '(not income)'}</span>
                    </dt>
                    <dd className="font-medium">{fmt(view.draft.fx_translation_adjustment ?? 0)}</dd>
                  </div>
                )}
                {isStaff && (
                  <div className={`flex justify-between border-t border-zinc-100 pt-1.5 ${Math.abs(view.draft.balance_sheet_check ?? 0) > 1 ? 'text-red-700 font-semibold' : 'text-emerald-700'}`}>
                    <dt>{Math.abs(view.draft.balance_sheet_check ?? 0) > 1 ? '⚠ Balance check (off by)' : '✓ Balance check'}</dt>
                    <dd>{fmt(view.draft.balance_sheet_check ?? 0)}</dd>
                  </div>
                )}
              </dl>
            </section>
          </div>



          {/* S2 slice 2 — per-bank balance anchors (books mode only: the staff
              workspace tool has no account). The two statement-header numbers
              that verify each account: opening + transactions = closing. */}
          {accountId && (view.draft.banks?.length ?? 0) > 0 && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900 mb-1">{it ? 'Saldi bancari — inizio e fine anno' : 'Bank balances — start and end of year'}</h2>
              <p className="text-xs text-zinc-600 mb-3">
                {it
                  ? `Copia dall'estratto conto di ogni banca il saldo al 1° gennaio e al 31 dicembre ${taxYear} (nella valuta del conto). Con questi due numeri verifichiamo ogni conto: saldo iniziale + movimenti = saldo finale — e se qualcosa non torna ti diciamo esattamente quale banca e di quanto.`
                  : `Copy each bank's balance on January 1 and December 31, ${taxYear} from its statement (in the account's own currency). These two numbers let us verify every account: opening + transactions = closing — and if something is off we name the exact bank and amount.`}
              </p>
              {balError && (
                <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">⚠ {balError}</div>
              )}
              <div className="space-y-2">
                {(view.draft.banks ?? []).map(b => {
                  const tie = view.draft.bank_balances?.banks.find(x => x.bank_key === b.bank_key)
                  return (
                    <div key={b.bank_key} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2">
                      <span className="min-w-[160px] flex-1 text-sm font-medium text-zinc-800">{b.bank_key} <span className="text-[11px] font-normal text-zinc-400">({b.currency})</span></span>
                      <label className="flex items-center gap-1 text-xs text-zinc-500">
                        {it ? '1 gen' : 'Jan 1'}
                        <input
                          type="text"
                          inputMode="decimal"
                          value={balDraft[b.bank_key]?.opening ?? ''}
                          placeholder="0.00"
                          onChange={e => { setBalDirty(true); setBalSaved(false); setBalDraft(d => ({ ...d, [b.bank_key]: { opening: e.target.value, closing: d[b.bank_key]?.closing ?? '' } })) }}
                          className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-sm text-right"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-zinc-500">
                        {it ? '31 dic' : 'Dec 31'}
                        <input
                          type="text"
                          inputMode="decimal"
                          value={balDraft[b.bank_key]?.closing ?? ''}
                          placeholder="0.00"
                          onChange={e => { setBalDirty(true); setBalSaved(false); setBalDraft(d => ({ ...d, [b.bank_key]: { opening: d[b.bank_key]?.opening ?? '', closing: e.target.value } })) }}
                          className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-sm text-right"
                        />
                      </label>
                      {tie?.tie === 'ok' && <span className="text-xs font-medium text-emerald-700">✓ {it ? 'torna' : 'ties'}</span>}
                      {tie?.tie === 'mismatch' && (
                        <span className="text-xs font-medium text-amber-700">
                          ⚠ {it ? 'differenza' : 'off by'} {fmt(Math.abs(tie.delta_usd ?? 0))} USD
                        </span>
                      )}
                      {tie?.provided_conflicts_derived && (
                        <span className="text-xs font-medium text-red-700">⚠ {it ? 'diverso dall\u2019estratto' : 'differs from statement'}</span>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => void saveBalances()}
                  disabled={busyOrLocked || !balDirty}
                  className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
                >
                  {busy === 'balances' ? (it ? 'Salvataggio…' : 'Saving…') : (it ? 'Salva saldi' : 'Save balances')}
                </button>
                {balSaved && !balDirty && <span className="text-xs text-emerald-700">✓ {it ? 'Salvati' : 'Saved'}</span>}
                <span className="text-[11px] text-zinc-400">
                  {it ? 'I saldi forniti sono indicati come tali nel bilancio — non sostituiscono gli estratti conto.' : 'Provided balances are labeled as such on the balance sheet — they never replace your statements.'}
                </span>
              </div>
            </section>
          )}

          {/* Members */}
          {view.draft.members.length > 0 && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 overflow-x-auto">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'Capitale per socio (K-1)' : 'Capital per member (K-1)'}</h2>
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="py-1 pr-3 font-medium">{it ? 'Socio' : 'Member'}</th>
                    <th className="py-1 pr-3 font-medium">%</th>
                    <th className="py-1 pr-3 font-medium text-right">{it ? 'Iniziale' : 'Beginning'}</th>
                    <th className="py-1 pr-3 font-medium text-right">{it ? 'Apporti' : 'Contributions'}</th>
                    <th className="py-1 pr-3 font-medium text-right">{it ? 'Utile' : 'Income'}</th>
                    <th className="py-1 pr-3 font-medium text-right">{it ? 'Prelievi' : 'Distributions'}</th>
                    <th className="py-1 font-medium text-right">{it ? 'Finale' : 'Ending'}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.draft.members.map(m => (
                    <tr key={m.name} className="border-t border-zinc-100">
                      <td className="py-1.5 pr-3 font-medium text-zinc-800">{m.name}</td>
                      <td className="py-1.5 pr-3">{m.pct}%</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(m.beginning_capital)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(m.contributions)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(m.income_share)}</td>
                      <td className="py-1.5 pr-3 text-right">−{fmt(m.distributions)}</td>
                      <td className="py-1.5 text-right font-medium">{fmt(m.ending_capital)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* LOCATION-PERIOD TRIAGE (Phase 2b, staff-only v1): one question per
              detected presence stretch instead of hundreds of merchant rows.
              Interrogative copy + top merchants so a wrong detection is
              falsifiable at a glance; answers apply ONLY from the confirm
              dialog and are fully undoable (exact prior-state restore). */}
          {/* Phase B2 (2026-07-08): visible to the CLIENT too — the portal GET
              now serves the same cards from the books. Staff-only wording
              (CRM references, third-person "the client") is mode-switched. */}
          {((view.periods?.length ?? 0) > 0 || (view.period_answers?.length ?? 0) > 0 || (view.country_cards?.length ?? 0) > 0) && (
            <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 sm:p-5">
              <h3 className="text-sm font-bold text-indigo-900 mb-1">
                🌍 {it ? 'Periodi fuori sede rilevati' : 'Time away from home base detected'}
              </h3>
              <p className="text-xs text-zinc-600 mb-3">
                {view.residence_on_file || (!isStaff && view.residence_country)
                  ? (it
                    ? `Residenza fiscale registrata: ${locLabel(view.residence_country ?? '', it)}. Le spese fatte lì restano nella revisione normale; per i periodi all'estero basta UNA risposta.`
                    : `Fiscal residence on file: ${locLabel(view.residence_country ?? '', it)}. Spending there stays in the normal review; each period away needs just ONE answer.`)
                  : isStaff
                    ? (it
                      ? 'Nessuna residenza fiscale registrata nel CRM per questo cliente — mostriamo tutti i periodi rilevati.'
                      : 'No fiscal residence on file in the CRM for this client — showing every detected period.')
                    : (it
                      ? 'Spese rilevate in questi paesi, già registrate come aziendali (regola: fuori dal paese di residenza = azienda). Non serve fare nulla — tocca solo per correggere.'
                      : 'Spending we detected in these countries, already booked as business (rule: outside your home country = business). Nothing is required — tap only to correct it.')}
              </p>
              {periodError && (
                <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                  ⚠ {periodError}
                </div>
              )}
              <div className="space-y-3">
                {/* S3 — country-policy cards: one tap books EVERY still-open
                    located transaction of that country for the whole year
                    (isolated purchases too, not just travel windows). */}
                {(view.country_cards ?? []).map(c => (
                  <div key={`country-${c.loc_code}`} className="rounded-lg border border-indigo-300 bg-indigo-50/60 p-3 sm:p-4">
                    <div className="text-sm font-semibold text-zinc-900">
                      {it
                        ? `${locLabel(c.loc_code, it)}, tutto l'anno — ${c.count} transazioni · $${fmt(c.total)}`
                        : `${locLabel(c.loc_code, it)}, whole year — ${c.count} transactions · $${fmt(c.total)}`}
                    </div>
                    <div className="mt-1 text-xs text-zinc-600">
                      {/* Antonio's ruling (card 85f6f0b2): the residence default
                          ALREADY decided this — spending outside the home
                          country is business. So the card states what we booked
                          and why, and never implies a decision is owed. It is
                          informational, not a Confirm blocker. */}
                      {it
                        ? `Registrate come spese aziendali, perché fuori dal tuo paese di residenza. Tocca solo se qualcosa era personale.`
                        : `Booked as business spending, because it's outside your home country. Tap only if some of it was personal.`}
                      {c.merchants.length > 0 && (
                        <span className="text-zinc-500"> ({it ? 'principali' : 'top merchants'}: {c.merchants.join(', ')})</span>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        disabled={busyOrLocked}
                        onClick={() => setCountryConfirm({ card: c, choice: 'business' })}
                        className="rounded-full border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {it ? 'Tutto aziendale' : 'All business'}
                      </button>
                      <button
                        disabled={busyOrLocked}
                        onClick={() => setCountryConfirm({ card: c, choice: 'personal' })}
                        className="rounded-full border border-amber-500 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        {it ? 'Tutto personale' : 'All personal'}
                      </button>
                      <button
                        disabled={busyOrLocked}
                        onClick={() => setInlineReview(k => k === `country-${c.loc_code}` ? null : `country-${c.loc_code}`)}
                        className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                      >
                        {it ? 'Controllo una per una' : 'Review one-by-one'} {inlineReview === `country-${c.loc_code}` ? '▲' : '▼'}
                      </button>
                    </div>
                    {renderInlineReview(`country-${c.loc_code}`, c.keys)}
                  </div>
                ))}
                {(view.periods ?? []).map(p => {
                  const key = `period-${p.primary}-${p.start}`
                  return (
                    <div key={key} className="rounded-lg border border-indigo-200 bg-white p-3 sm:p-4">
                      <div className="text-sm font-semibold text-zinc-900">
                        {it
                          ? `Eri in ${periodLabel(p, it)} dal ${fmtDay(p.start, it)} al ${fmtDay(p.end, it)}?`
                          : `Were you in ${periodLabel(p, it)}, ${fmtDay(p.start, it)} – ${fmtDay(p.end, it)}?`}
                      </div>
                      <div className="mt-1 text-xs text-zinc-600">
                        {it
                          ? `${p.row_count} transazioni sul posto · $${fmt(p.dollar_total)}`
                          : `${p.row_count} in-person transactions · $${fmt(p.dollar_total)}`}
                      <span className="block mt-0.5">
                        {/* Same ruling as the country cards: already booked by
                            the residence default; the tap is a correction, not
                            an obligation. */}
                        {it
                          ? 'Già registrate come spese aziendali. Tocca solo se erano personali.'
                          : 'Already booked as business spending. Tap only if it was personal.'}
                      </span>
                        {p.top_merchants.length > 0 && (
                          <span className="text-zinc-500"> ({it ? 'principali' : 'top merchants'}: {p.top_merchants.join(', ')})</span>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          disabled={busyOrLocked}
                          onClick={() => setPeriodConfirm({ period: p, choice: 'business' })}
                          className="rounded-full border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {it ? 'Tutto aziendale' : 'All business'}
                        </button>
                        <button
                          disabled={busyOrLocked}
                          onClick={() => setPeriodConfirm({ period: p, choice: 'personal' })}
                          className="rounded-full border border-amber-500 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                        >
                          {it ? 'Tutto personale' : 'All personal'}
                        </button>
                        <button
                          disabled={busyOrLocked}
                          onClick={() => setInlineReview(k => k === key ? null : key)}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                        >
                          {it ? 'Controllo una per una' : 'Review one-by-one'} {inlineReview === key ? '▲' : '▼'}
                        </button>
                      </div>
                      {renderInlineReview(key, p.group_keys)}
                    </div>
                  )
                })}
                {(view.period_answers ?? []).map(b => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                    <span>
                      ✓ {b.actor_role === 'system'
                        ? (it ? 'Registrato automaticamente secondo la regola fissa del paese' : 'Booked automatically under the standing country policy')
                        : b.actor_role === 'client'
                          ? (isStaff
                            ? (it ? 'Il cliente ha attestato' : 'Client attested')
                            : (it ? 'Hai risposto tu' : 'You answered'))
                          : isStaff
                            ? (it ? 'Registrato dallo staff su indicazione del cliente' : 'Staff booked on client\'s instruction')
                            : (it ? 'Registrato dal nostro team' : 'Booked by our team')}
                      {': '}
                      <strong className="text-zinc-800">{b.loc_codes.map(c => locLabel(c, it)).join(' / ')} {fmtDay(b.period_start, it)} – {fmtDay(b.period_end, it)} = {b.choice === 'business' ? (it ? 'aziendale' : 'business') : (it ? 'personale' : 'personal')}</strong>
                      {` (${b.row_count} ${it ? 'righe' : 'rows'}, $${fmt(b.dollar_total)})`}
                    </span>
                    <span className="flex items-center gap-2">
                      {b.actor_role === 'system' && (
                        <span className="text-[11px] text-zinc-400">
                          {it ? 'Annullare ferma anche la regola fissa' : 'Undo also stops the standing policy'}
                        </span>
                      )}
                      {/* Clients can revert only their OWN answers (the server
                          enforces the same rule) — staff/system batches show a
                          "message us" hint instead of a dead button. */}
                      {(isStaff || b.actor_role === 'client') ? (
                        <button
                          disabled={busyOrLocked}
                          onClick={() => void undoPeriodAnswer(b.id)}
                          className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-600 hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                        >
                          {it ? 'Annulla' : 'Undo'}
                        </button>
                      ) : (
                        <span className="text-[11px] text-zinc-400">
                          {it ? 'Scrivici in chat per modificarla' : 'Message us to change it'}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Re-run confirm (2026-07-06) */}
          {rerunConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
              <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
                <h4 className="text-sm font-bold text-zinc-900">Re-run the P&amp;L?</h4>
                <p className="mt-2 text-sm text-zinc-700">
                  Re-applies every rule and everything the system has learned over all transactions, then runs the AI on whatever is still open.
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Every answer you or the client gave is kept — re-running never undoes a human decision.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRerunConfirm(false)}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busyOrLocked}
                    onClick={() => { setRerunConfirm(false); void generate() }}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Re-run
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* S3 — country-policy confirm: exact counts, undo promise, personal
              draw-split disclosure — never a one-click sweep. */}
          {countryConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
              <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
                <h4 className="text-sm font-bold text-zinc-900">
                  {countryConfirm.choice === 'business'
                    ? (it ? `Registrare TUTTO ${locLabel(countryConfirm.card.loc_code, it)} come AZIENDALE?` : `Book EVERYTHING in ${locLabel(countryConfirm.card.loc_code, it)} as BUSINESS?`)
                    : (it ? `Registrare TUTTO ${locLabel(countryConfirm.card.loc_code, it)} come PERSONALE?` : `Book EVERYTHING in ${locLabel(countryConfirm.card.loc_code, it)} as PERSONAL?`)}
                </h4>
                <p className="mt-2 text-sm text-zinc-800">
                  {it
                    ? <><strong>{countryConfirm.card.count}</strong> transazioni per <strong>${fmt(countryConfirm.card.total)}</strong> — l&apos;intero anno fiscale, acquisti isolati inclusi.</>
                    : <><strong>{countryConfirm.card.count}</strong> transactions totalling <strong>${fmt(countryConfirm.card.total)}</strong> — the whole tax year, isolated purchases included.</>}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {it ? 'Le righe già decise a mano non vengono mai toccate. Trasferimenti e incassi esclusi.' : 'Hand-answered rows are never touched. Transfers and income are excluded.'}
                </p>
                {countryConfirm.choice === 'personal' && (
                  <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                    {it
                      ? 'Nota: registrate come prelievi dei soci ripartiti per quota di proprietà.'
                      : 'Note: recorded as owner draws split by ownership %.'}
                  </p>
                )}
                <p className="mt-2 text-xs text-zinc-500">{it ? 'Puoi annullare questa operazione in qualsiasi momento.' : 'You can undo this at any time.'}</p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setCountryConfirm(null)}
                    /* Never gated on the lock — see the bulk dialog's Cancel. */
                    disabled={busy !== null}
                    className="rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                  >
                    {it ? 'Annulla' : 'Cancel'}
                  </button>
                  <button
                    onClick={() => void confirmCountryAnswer()}
                    disabled={busyOrLocked}
                    className={countryConfirm.choice === 'business'
                      ? 'rounded-full border border-emerald-600 bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50'
                      : 'rounded-full border border-amber-500 bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50'}
                  >
                    {busy !== null ? (it ? 'Registrazione…' : 'Booking…') : (it ? 'Conferma' : 'Confirm')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Period-answer confirm dialog (B&P2 guard): exact counts, what's
              excluded, MMLLC draw-split disclosure — never a one-click sweep. */}
          {periodConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
              <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
                <h4 className="text-sm font-bold text-zinc-900">
                  {periodConfirm.choice === 'business'
                    ? (it ? 'Registrare tutto il periodo come AZIENDALE?' : 'Book the whole period as BUSINESS?')
                    : (it ? 'Registrare tutto il periodo come PERSONALE?' : 'Book the whole period as PERSONAL?')}
                </h4>
                <p className="mt-2 text-xs text-zinc-600">
                  {periodLabel(periodConfirm.period, it)} · {fmtDay(periodConfirm.period.start, it)} – {fmtDay(periodConfirm.period.end, it)}
                </p>
                <p className="mt-2 text-sm text-zinc-800">
                  {it
                    ? <><strong>{periodConfirm.period.sweepable_count}</strong> transazioni per <strong>${fmt(periodConfirm.period.sweepable_total)}</strong> verranno registrate.</>
                    : <><strong>{periodConfirm.period.sweepable_count}</strong> transactions totalling <strong>${fmt(periodConfirm.period.sweepable_total)}</strong> will be booked.</>}
                </p>
                {periodConfirm.period.row_count > periodConfirm.period.sweepable_count && (
                  <p className="mt-1 text-xs text-zinc-500">
                    {it
                      ? `${periodConfirm.period.row_count - periodConfirm.period.sweepable_count} righe già decise a mano o non idonee restano come sono.`
                      : `${periodConfirm.period.row_count - periodConfirm.period.sweepable_count} rows already hand-answered or ineligible stay as they are.`}
                  </p>
                )}
                <p className="mt-1 text-xs text-zinc-500">
                  {it ? 'Abbonamenti, trasferimenti e incassi non vengono mai toccati da questa risposta.' : 'Subscriptions, transfers and income are never touched by this answer.'}
                </p>
                {periodConfirm.choice === 'personal' && (
                  <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                    {it
                      ? 'Nota: verranno registrate come prelievi dei soci ripartiti per quota di proprietà (non attribuiti a un socio specifico).'
                      : 'Note: these will be recorded as owner draws split by ownership % (not attributed to a specific member).'}
                  </p>
                )}
                <p className="mt-2 text-xs text-zinc-500">{it ? 'Puoi annullare questa operazione in qualsiasi momento.' : 'You can undo this at any time.'}</p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setPeriodConfirm(null)}
                    /* Never gated on the lock — see the bulk dialog's Cancel. */
                    disabled={busy !== null}
                    className="rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                  >
                    {it ? 'Annulla' : 'Cancel'}
                  </button>
                  <button
                    onClick={() => void confirmPeriodAnswer()}
                    disabled={busyOrLocked}
                    className={periodConfirm.choice === 'business'
                      ? 'rounded-full border border-emerald-600 bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50'
                      : 'rounded-full border border-amber-500 bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50'}
                  >
                    {busy !== null ? (it ? 'Registrazione…' : 'Booking…') : (it ? 'Conferma' : 'Confirm')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bulk-select action bar: appears when groups are ticked. Chips are
              direction-valid for the whole selection (one direction at a time). */}
          {bulkSel.size > 0 && !bulkConfirm && (
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-blue-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur">
              <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-zinc-800">
                  {it
                    ? `${bulkSel.size} gruppi · ${Array.from(bulkSel.values()).reduce((s, g) => s + g.count, 0)} transazioni`
                    : `${bulkSel.size} groups · ${Array.from(bulkSel.values()).reduce((s, g) => s + g.count, 0)} transactions`}
                </span>
                <span className="text-xs text-zinc-400">{it ? 'Registra come:' : 'Book as:'}</span>
                {ANSWERS.filter(a => bulkDir && a.directions.includes(bulkDir)).map(a => (
                  <button
                    key={a.value}
                    disabled={busyOrLocked}
                    onClick={() => setBulkConfirm(a.value)}
                    className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    {it ? a.it : a.en}
                  </button>
                ))}
                <button
                  onClick={() => setBulkSel(new Map())}
                  disabled={busyOrLocked}
                  className="ml-auto rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-500 hover:border-zinc-900 hover:text-zinc-900"
                >
                  {it ? 'Annulla selezione' : 'Clear selection'} ✕
                </button>
              </div>
            </div>
          )}

          {/* Bulk confirm — ALWAYS, never one-click (reviewer condition). */}
          {bulkConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
              <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
                <h4 className="text-sm font-bold text-zinc-900">
                  {it ? 'Registrare i gruppi selezionati come ' : 'Book the selected groups as '}
                  “{(() => { const a = ANSWERS.find(x => x.value === bulkConfirm); return a ? (it ? a.it : a.en) : bulkConfirm })()}”?
                </h4>
                {(() => {
                  const groups = Array.from(bulkSel.values())
                  const txns = groups.reduce((s, g) => s + g.count, 0)
                  const byCur = new Map<string, number>()
                  for (const g of groups) byCur.set(g.currency ?? '', (byCur.get(g.currency ?? '') ?? 0) + g.total)
                  const totals = Array.from(byCur.entries()).map(([c, t]) => `${fmt(t)}${c && c !== 'USD' ? ` ${c}` : ''}`).join(' + ')
                  const names = groups.slice(0, 8).map(g => g.label).join(', ')
                  return (
                    <>
                      <p className="mt-2 text-sm text-zinc-800">
                        {it
                          ? <><strong>{groups.length}</strong> gruppi · <strong>{txns}</strong> transazioni · <strong>{totals}</strong></>
                          : <><strong>{groups.length}</strong> groups · <strong>{txns}</strong> transactions · <strong>{totals}</strong></>}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">{names}{groups.length > 8 ? ` +${groups.length - 8} ${it ? 'altri' : 'more'}` : ''}</p>
                    </>
                  )
                })()}
                <p className="mt-2 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600">
                  {it
                    ? 'Vale solo per quest’anno: una risposta in blocco non viene memorizzata come regola permanente. Rispondi ai gruppi uno per uno se vuoi che il sistema li ricordi per i prossimi anni.'
                    : 'This books this year only — a bulk answer is not remembered as a permanent rule. Answer groups one by one when you want the system to remember them for future years.'}
                </p>
                <p className="mt-2 text-xs text-zinc-500">{it ? 'Potrai annullare subito dopo.' : 'You can undo right after.'}</p>
                {bulkError && (
                  <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                    ⚠ {bulkError}
                  </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => { setBulkConfirm(null); setBulkError(null) }}
                    /* NEVER gated on the lock: closing a dialog changes nothing,
                       and if the file locks while this is open a disabled Cancel
                       traps the client behind a full-screen overlay with no way
                       out but a page reload. */
                    disabled={busy !== null}
                    className="rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                  >
                    {it ? 'Annulla' : 'Cancel'}
                  </button>
                  <button
                    onClick={() => void confirmBulkAnswer()}
                    disabled={busyOrLocked}
                    className="rounded-full border border-blue-600 bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {busy !== null ? (it ? 'Registrazione…' : 'Booking…') : (it ? 'Conferma' : 'Confirm')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bulk undo banner — one exact undo of the last bulk booking. */}
          {bulkUndo && (
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-emerald-200 bg-emerald-50/95 px-4 py-3 backdrop-blur">
              <div className="mx-auto flex max-w-3xl items-center gap-3">
                <span className="text-xs font-medium text-emerald-900">
                  ✓ {it ? `${bulkUndo.count} transazioni registrate.` : `${bulkUndo.count} transactions booked.`}
                </span>
                <button
                  onClick={() => void undoBulkAnswer()}
                  disabled={busyOrLocked}
                  className="rounded-full border border-emerald-600 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {busy === 'bulk-undo' ? (it ? 'Annullamento…' : 'Undoing…') : (it ? 'Annulla' : 'Undo')}
                </button>
                <button
                  onClick={() => setBulkUndo(null)}
                  disabled={busyOrLocked}
                  className="ml-auto text-xs text-emerald-700 hover:text-emerald-900"
                >
                  {it ? 'Chiudi' : 'Dismiss'} ✕
                </button>
              </div>
            </div>
          )}

          {/* TRIAGE-FIRST REVIEW (Antonio, 2026-07-03): the screen is a WORK
              QUEUE, not an archive. Tier 1 (expanded): only groups that need a
              human decision. Tier 2 (collapsed): booked but worth a glance
              (AI leaned personal/unsure). Tier 3 (collapsed to bucket
              summaries): everything booked automatically — open only to audit
              or correct. Guide box tells the client what they MUST vs CAN do. */}
          {view.questions.length > 0 && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
              {(() => {
                const bucketLabel = new Map(view.buckets.map(b => [b.slug, b.label]))
                // Review-one-by-one period filter (zero writes): narrows every
                // tier to the merchants seen inside the selected period.
                // Compare on the merchant ROOT: presence-periods emits bare
                // rowRootKey keys, while group_key now carries a
                // direction+currency suffix (per-direction split 2026-07-05).
                const inFilter = (g: QuestionGroup) => !periodFilter || periodFilter.keys.has(groupKeyRoot(g.group_key))
                // A group needs a decision when it is undecided OR when we
                // suspect one of its payments went to an owner.
                //
                // THE MARK, NOT THE CATEGORY, EARNS TIER 1 (2026-08-04). The
                // first design forced these into Tier 1 by rewriting the
                // category to 'uncategorized', which collided with the AI pass,
                // the re-sort and the two surfaces' different treatment of
                // undecided rows. Promoting on the mark instead gives the same
                // prominence with none of that — and it is the ONLY thing that
                // re-asks a payee the client once answered "business expense"
                // for, since the learned rule keeps booking it as an expense.
                // Without this line the question lands in the section the page
                // explicitly labels optional, and would simply never be seen.
                const isSuspected = (g: QuestionGroup) => (g.suspected_count ?? 0) > 0
                const needs = view.questions.filter(g => inFilter(g) && ((g.current_category ?? 'uncategorized') === 'uncategorized' || isSuspected(g)))
                const booked = view.questions.filter(g => inFilter(g) && (g.current_category ?? 'uncategorized') !== 'uncategorized' && !isSuspected(g))
                const glance = booked.filter(g => g.ai_lean === 'personal' || g.ai_lean === 'unsure' || !g.ai_lean)
                const autoBooked = booked.filter(g => g.ai_lean === 'business')
                const needsIn = needs.filter(g => g.direction !== 'out')
                const needsOut = needs.filter(g => g.direction === 'out')

                const renderCard = renderQuestionCard

                const toggle = (key: string) => setOpenSections(s => {
                  const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n
                })

                return (
                  <>
                    {periodFilter && (
                      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
                        <span>🌍 {it ? 'Stai controllando solo' : 'Reviewing only'}: <strong>{periodFilter.label}</strong></span>
                        <button
                          onClick={() => setPeriodFilter(null)}
                          className="rounded-full border border-indigo-300 bg-white px-2.5 py-0.5 font-medium text-indigo-700 hover:border-indigo-600"
                        >
                          {it ? 'Mostra tutto' : 'Show all'} ✕
                        </button>
                      </div>
                    )}
                    {/* Guide: what this screen is, what you MUST do, what you CAN do. */}
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 sm:p-4 mb-4 text-xs text-zinc-600 space-y-1.5">
                      <p className="text-sm font-semibold text-zinc-900">{it ? 'Come funziona questa revisione' : 'How this review works'}</p>
                      <p>
                        {it
                          ? 'Abbiamo letto i tuoi estratti conto e registrato automaticamente ogni transazione — l\'etichetta blu ✓ mostra come è stata registrata ciascuna voce.'
                          : 'We read your bank statements and booked every transaction automatically — the blue ✓ chip shows how each item is booked.'}
                      </p>
                      <p>
                        <strong>{it ? 'Cosa DEVI fare: ' : 'What you MUST do: '}</strong>
                        {/* Counts EVERYTHING that blocks Confirm, from the same
                            expression the Confirm button uses — not just the
                            merchant decisions (the false all-clear Antonio hit). */}
                        {confirmBlockers.length === 0
                          ? (it ? 'niente — puoi confermare.' : 'nothing — you can confirm.')
                          : confirmBlockers.map(b => (it ? b.labelIt : b.label)).join(it ? '; ' : '; ') + '.'}
                      </p>
                      <p>
                        <strong>{it ? 'Cosa PUOI fare (facoltativo): ' : 'What you CAN do (optional): '}</strong>
                        {it
                          ? 'aprire le sezioni qui sotto per controllare ciò che abbiamo registrato e correggerlo con un tocco — ad esempio segnare come “Personale” una spesa che era tua e non della società.'
                          : 'open the sections below to double-check anything we booked and correct it with one tap — for example marking something as “Personal” if it was yours, not the company\'s.'}
                      </p>
                      <p>
                        {it
                          ? 'Ogni risposta viene ricordata e applicata automaticamente l\'anno prossimo. Quando “Serve una tua decisione” è vuoto, hai finito.'
                          : 'Every answer is remembered and applied automatically next year. When “Needs your decision” is empty, you\'re done.'}
                      </p>
                      <p className="text-zinc-500">
                        {booked.length} {it ? 'gruppi registrati automaticamente' : 'groups booked automatically'} · <strong className="text-zinc-800">{needs.length} {it ? 'da decidere' : 'need your decision'}</strong>
                      </p>
                    </div>

                    {/* TIER 1 — Needs your decision (the work queue). Money in /
                        Money out are collapsible but START OPEN while they hold
                        work (a hidden queue = dead Confirm button with no visible
                        reason); an emptied section vanishes on its own. Long
                        sections cap at 10 cards with "Show all N". */}
                    {needs.length > 0 ? (
                      <div className="mb-5 rounded-xl border-2 border-amber-300 bg-amber-50/50 p-3 sm:p-4">
                        <h3 className="text-sm font-bold text-amber-900 mb-2">
                          🖐 {it ? `Serve una tua decisione · ${needs.length}` : `Needs your decision · ${needs.length}`}
                        </h3>
                        {([
                          { key: 'in', list: needsIn, label: it ? 'Soldi in entrata' : 'Money in' },
                          { key: 'out', list: needsOut, label: it ? 'Soldi in uscita' : 'Money out' },
                        ] as const).map(({ key, list, label }) => {
                          if (list.length === 0) return null
                          const open = !closedNeeds.has(key)
                          const showAll = showAllNeeds.has(key)
                          const shown = showAll ? list : list.slice(0, 10)
                          // Net total only when the whole section is one currency —
                          // summing EUR+USD into one number would be a lie.
                          const curs = new Set(list.map(g => g.currency ?? ''))
                          const net = curs.size === 1 ? list.reduce((s, g) => s + g.total, 0) : null
                          const onlyCur = curs.size === 1 ? Array.from(curs)[0] : ''
                          return (
                            <div key={key} className={key === 'in' && needsOut.length > 0 ? 'mb-3' : ''}>
                              <button
                                type="button"
                                onClick={() => setClosedNeeds(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })}
                                className="flex w-full items-center justify-between py-1 text-left"
                              >
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                                  {label} · {list.length}{net !== null ? ` · ${fmt(net)}${onlyCur && onlyCur !== 'USD' ? ` ${onlyCur}` : ''}` : ''}
                                </span>
                                <span className="text-amber-700 text-xs">{open ? '▲' : '▼'}</span>
                              </button>
                              {open && (
                                <>
                                  <div className="space-y-2">{shown.map(renderCard)}</div>
                                  {list.length > shown.length && (
                                    <button
                                      type="button"
                                      onClick={() => setShowAllNeeds(s => new Set(s).add(key))}
                                      className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:border-amber-500"
                                    >
                                      {it ? `Mostra tutte e ${list.length}` : `Show all ${list.length}`}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className={`mb-5 rounded-xl border-2 px-4 py-4 text-sm font-semibold ${
                        confirmBlockers.length === 0
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                          : 'border-amber-300 bg-amber-50 text-amber-900'
                      }`}>
                        {/* Scoped honestly: this section is about merchant
                            decisions, so it says THAT — and when something else
                            still blocks Confirm it names it instead of implying
                            the client is finished. */}
                        {confirmBlockers.length === 0
                          ? `✓ ${it ? 'Tutto registrato — non serve nessuna decisione.' : 'All booked — nothing needs your decision.'}`
                          : `✓ ${it ? 'Nessuna spesa da decidere qui. Resta da fare: ' : 'No merchant decisions left here. Still to do: '}${confirmBlockers.map(b => (it ? b.labelIt : b.label)).join('; ')}.`}
                      </div>
                    )}

                    {/* TIER 2 — Booked, worth a glance (collapsed). */}
                    {glance.length > 0 && (
                      <div className="mb-4 rounded-lg border border-zinc-200">
                        <button type="button" onClick={() => toggle('glance')} className="flex w-full items-center justify-between px-3 py-2.5 text-left">
                          <span className="text-sm font-medium text-zinc-800">
                            👀 {it ? `Registrate — vale la pena dare un'occhiata · ${glance.length}` : `Booked — worth a glance · ${glance.length}`}
                          </span>
                          <span className="text-zinc-400 text-xs">{openSections.has('glance') ? '▲' : '▼'}</span>
                        </button>
                        {openSections.has('glance') && (
                          <div className="space-y-2 px-3 pb-3">
                            <p className="text-[11px] text-zinc-500">{it ? 'Già incluse nei totali; l\'AI le ha segnalate come possibilmente personali o incerte.' : 'Already in the totals; the AI flagged these as possibly personal or uncertain.'}</p>
                            {glance.map(renderCard)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* TIER 3 — Booked automatically, collapsed to bucket summaries. */}
                    {autoBooked.length > 0 && (
                      <div className="mb-2 rounded-lg border border-zinc-200">
                        <button type="button" onClick={() => toggle('auto')} className="flex w-full items-center justify-between px-3 py-2.5 text-left">
                          <span className="text-sm font-medium text-zinc-800">
                            ✅ {it ? `Registrate automaticamente · ${autoBooked.length} gruppi` : `Booked automatically · ${autoBooked.length} groups`}
                          </span>
                          <span className="text-zinc-400 text-xs">{openSections.has('auto') ? '▲' : '▼'}</span>
                        </button>
                        {openSections.has('auto') && (
                          <div className="px-3 pb-3">
                            <p className="text-[11px] text-zinc-500 mb-2">
                              {it ? 'Tutto qui è già nei totali. Apri una categoria solo per verificare o correggere.' : 'Everything here is already in the totals. Open a category only to double-check or correct.'}
                            </p>
                            {(() => {
                              const byBucket = new Map<string, QuestionGroup[]>()
                              for (const g of autoBooked) {
                                const key = g.ai_bucket && bucketLabel.has(g.ai_bucket) ? g.ai_bucket : '__other__'
                                if (!byBucket.has(key)) byBucket.set(key, [])
                                byBucket.get(key)!.push(g)
                              }
                              return Array.from(byBucket.entries()).map(([slug, groups]) => {
                                const label = slug === '__other__' ? (it ? 'Altro' : 'Other') : (bucketLabel.get(slug) ?? slug)
                                const total = groups.reduce((s, g) => s + g.total, 0)
                                const key = `bucket:${slug}`
                                return (
                                  <div key={slug} className="border-t border-zinc-100 first:border-t-0">
                                    <button type="button" onClick={() => toggle(key)} className="flex w-full items-center justify-between py-2 text-left">
                                      <span className="text-xs font-semibold text-zinc-700">{label} · {groups.length} {it ? 'voci' : 'merchants'}</span>
                                      <span className="text-xs text-zinc-500">{fmt(total)} <span className="text-zinc-300 ml-1">{openSections.has(key) ? '▲' : '▼'}</span></span>
                                    </button>
                                    {openSections.has(key) && <div className="space-y-2 pb-2">{groups.map(renderCard)}</div>}
                                  </div>
                                )
                              })
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}
              {/* Add a new bucket — flexible, shared vocabulary (#2). A bucket added
                  here is saved globally and offered to everyone next time. Hidden in
                  the staff workspace tool: a scratch workspace must NOT write to the
                  global expense-category catalog (sealed leak #1). */}
              {!isStaff && (
              <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
                <span className="text-xs text-zinc-500">{it ? 'Manca una categoria?' : 'Missing a category?'}</span>
                {/* The INPUT must be gated too, not just the button beside it
                    (browser QA 2026-08-03): Enter submits, so on a locked file
                    the button greyed out while typing-then-Enter still created a
                    category — under a banner saying nothing could be changed. */}
                <input
                  value={newBucket}
                  disabled={busyOrLocked}
                  onChange={e => setNewBucket(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !busyOrLocked) void addBucket() }}
                  placeholder={it ? 'Aggiungi categoria…' : 'Add a category…'}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 disabled:bg-zinc-100"
                />
                <button
                  disabled={busyOrLocked || newBucket.trim().length < 2}
                  onClick={() => void addBucket()}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 disabled:opacity-50"
                >
                  {it ? 'Aggiungi' : 'Add'}
                </button>
              </div>
              )}
            </section>
          )}

          {/* Coverage questions (§3.4) — what the exports don't span */}
          {view.coverage.questions.length > 0 && (
            <section className="rounded-xl border border-sky-200 bg-sky-50/50 p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900">{it ? 'Copertura dell\'anno' : 'Year coverage'}</h2>
              <p className="text-xs text-zinc-500 mt-1 mb-4">
                {it
                  ? 'Alcuni conti non coprono tutto l\'anno. Dicci se in quei mesi c\'era attività — se sì, ricarica l\'export completo.'
                  : 'Some accounts don\'t span the whole year. Tell us whether there was activity in those months — if yes, re-upload the complete export.'}
              </p>
              <div className="space-y-3">
                {view.coverage.questions.map(q => (
                  <div key={q.key} className="rounded-lg border border-zinc-200 bg-white p-3 sm:p-4">
                    <div className="text-sm text-zinc-800">{q.question}</div>
                    {q.answer === 'no_activity' ? (
                      <div className="mt-2 text-xs text-emerald-700">{it ? '✓ Nessuna attività — registrato.' : '✓ No activity — recorded.'}</div>
                    ) : q.answer === 'had_activity' ? (
                      <div className="mt-2 text-xs text-amber-700">
                        {it
                          ? 'Hai indicato che c\'era attività: elimina il file qui sotto e carica l\'export dell\'intero anno.'
                          : 'You said there was activity: delete the file below and upload the entire-year export.'}
                      </div>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          disabled={busyOrLocked}
                          onClick={() => void answerCoverage(q, 'no_activity')}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                        >
                          {it ? 'No — nessuna attività in quei mesi' : 'No — no activity in those months'}
                        </button>
                        <button
                          disabled={busyOrLocked}
                          onClick={() => void answerCoverage(q, 'had_activity')}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                        >
                          {it ? 'Sì — c\'era attività (devo ricaricare)' : 'Yes — there was activity (I need to re-upload)'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Files + add-a-statement uploader (shared with the empty state). */}
          {renderFormatProposals()}
          {renderStatements()}

          {/* Completeness summary (dev_task 95127bb2) — translate the checks
              that didn't fully pass into plain language so the client can
              provide more or accept as-is. */}
          {!attested && view.completeness.items.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">{it ? 'Cosa abbiamo trovato' : 'What we found'}</h2>
                <p className="text-xs text-zinc-600 mt-1">
                  {it
                    ? 'Questi numeri sono pronti. Alcune cose qui sotto restano incerte — puoi fornire più informazioni (modifica i tuoi dati o carica file qui sopra) oppure accettarli così come sono qui in fondo.'
                    : 'These numbers are ready. A few things below are still uncertain — you can provide more (edit your info or upload above) or accept them as they are at the bottom.'}
                </p>
              </div>

              {view.completeness.items.length > 0 && (
                <ul className="space-y-2">
                  {view.completeness.items.map((item, i) => (
                    <li key={`${item.code}-${i}`} className="flex items-start gap-2.5">
                      <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${item.severity === 'warn' ? 'text-amber-700 bg-amber-100' : 'text-zinc-500 bg-zinc-100'}`}>
                        {item.severity === 'warn' ? '!' : 'i'}
                      </span>
                      <span className="text-xs text-zinc-700">{completenessText(item)}</span>
                    </li>
                  ))}
                </ul>
              )}

            </section>
          )}

          {/* Download + Attest */}
          <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 space-y-4">
            <a
              href={`${API}/download?account_id=${accountId}&tax_year=${taxYear}`}
              className="inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900"
            >
              {it ? 'Scarica Excel (P&L + Stato Patrimoniale)' : 'Download Excel (P&L + Balance Sheet)'}
            </a>

            {!isStaff && (attested ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                {it ? 'Confermato — grazie. Procediamo noi da qui.' : 'Confirmed — thank you. We take it from here.'}
              </div>
            ) : (
              <div className="space-y-3">
                {/* Rich explanation — make sure the client understands what
                    "confirm" means and what they're responsible for before they
                    tick the box (Antonio, 2026-06-23). Plain language, no jargon. */}
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 space-y-2">
                  <p className="font-semibold text-zinc-900">{it ? 'Prima di confermare' : 'Before you confirm'}</p>
                  <ul className="space-y-1.5 list-disc pl-5">
                    <li>
                      {it
                        ? 'Questi sono il Conto Economico e lo Stato Patrimoniale che abbiamo preparato noi a partire dagli estratti conto che ci hai fornito.'
                        : 'These are the Profit & Loss and Balance Sheet we prepared for you from the bank statements you gave us.'}
                    </li>
                    <li>
                      {it
                        ? 'Confermando, ci dici che questi numeri sono corretti e che possiamo procedere a preparare la tua dichiarazione su questa base.'
                        : 'By confirming, you tell us these numbers are correct and that we can go ahead and prepare your tax return on this basis.'}
                    </li>
                    <li>
                      {it
                        ? 'Abbiamo lavorato solo con ciò che ci hai dato: se esistono altri conti o redditi che non abbiamo visto, vanno aggiunti — altrimenti la dichiarazione sarà incompleta. Quella scelta, e la sua responsabilità, sono tue.'
                        : 'We worked only with what you gave us: if there are other accounts or income we didn\'t see, they need to be added — otherwise the return is incomplete. That choice, and the responsibility for it, is yours.'}
                    </li>
                    {/* OPEN OWNER QUESTIONS. A flagged payment keeps whatever
                        category it had, so it is invisible to the "still
                        uncategorized" figures this block is built on — a client
                        could otherwise sign off reading "everything is
                        categorized" while a possible owner withdrawal is open.
                        Counted from the questions already in the payload, so
                        there is no second source of truth and no currency
                        conversion to get wrong. It does NOT block confirming. */}
                    {(() => {
                      const openOwnerQs = (view?.questions ?? []).reduce((n, q) => n + (q.suspected_count ?? 0), 0)
                      if (openOwnerQs === 0) return null
                      return (
                        <li className="font-medium text-amber-800">
                          {it
                            ? `${openOwnerQs} ${openOwnerQs === 1 ? 'pagamento potrebbe essere' : 'pagamenti potrebbero essere'} a un socio e ${openOwnerQs === 1 ? 'non ha' : 'non hanno'} ancora una tua risposta. Se ${openOwnerQs === 1 ? 'lo lasci' : 'li lasci'} così, ${openOwnerQs === 1 ? 'resterà registrato' : 'resteranno registrati'} come ${openOwnerQs === 1 ? 'è' : 'sono'} adesso.`
                            : `${openOwnerQs} ${openOwnerQs === 1 ? 'payment may be' : 'payments may be'} to an owner and ${openOwnerQs === 1 ? 'has' : 'have'} no answer from you yet. If you leave ${openOwnerQs === 1 ? 'it' : 'them'}, ${openOwnerQs === 1 ? 'it stays' : 'they stay'} booked as ${openOwnerQs === 1 ? 'it is' : 'they are'} now.`}
                        </li>
                      )
                    })()}
                    <li>
                      {it
                        ? 'Non sei ancora pronto? Puoi modificare le tue informazioni o caricare altri estratti conto qui sopra, invece di confermare.'
                        : 'Not ready yet? You can edit your information or upload more statements above instead of confirming.'}
                    </li>
                  </ul>
                </div>
                {/* Say the number OUT LOUD before they sign (2026-08-03,
                    Antonio: "we just suggest but they know the truth"). They
                    may confirm with items undecided — but never without being
                    told how many of these figures were our guess. */}
                {view.draft.pnl.foldedUncategorizedCount > 0 && (
                  <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
                    {it
                      ? `Attenzione: ${suggestedPhrase(view.draft.pnl.foldedUncategorizedCount, true)} ancora classificate da noi, non da te. Confermando accetti anche quelle.`
                      : `Heads up: ${suggestedPhrase(view.draft.pnl.foldedUncategorizedCount, false)} still classified by us, not by you. Confirming accepts those too.`}
                  </p>
                )}
                <label className="flex items-start gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={attestChecked} onChange={e => setAttestChecked(e.target.checked)} className="mt-0.5" />
                  <span>
                    {it
                      ? 'Confermo di aver controllato il Conto Economico e lo Stato Patrimoniale e accetto questi numeri così come sono, sulla base delle informazioni che ho fornito. Capisco che eventuali conti o redditi non comunicati sono una mia responsabilità.'
                      : 'I confirm I have checked the Profit & Loss and Balance Sheet and I accept these numbers as they are, based on the information I have provided. I understand that any accounts or income I have not reported are my responsibility.'}
                    {view.draft.pnl.foldedUncategorizedCount > 0 && (it
                      ? (view.draft.pnl.foldedUncategorizedCount === 1
                        ? ' Accetto inoltre la classificazione fatta dal vostro sistema che non ho verificato.'
                        : ` Accetto inoltre le ${view.draft.pnl.foldedUncategorizedCount} classificazioni fatte dal vostro sistema che non ho verificato.`)
                      : (view.draft.pnl.foldedUncategorizedCount === 1
                        ? ' I also accept the 1 classification made by your system that I have not reviewed.'
                        : ` I also accept the ${view.draft.pnl.foldedUncategorizedCount} classifications made by your system that I have not reviewed.`))}
                  </span>
                </label>
                <button
                  // ONE source of truth with the status header (card 85f6f0b2):
                  // confirmBlockers is built from exactly these conditions, so
                  // a disabled button always has a named reason on screen.
                  disabled={!attestChecked || !view.completeness.can_accept_as_is || confirmBlockers.length > 0 || busyOrLocked}
                  onClick={() => void attest()}
                  className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
                >
                  {it ? 'Accetto e confermo' : 'Accept and confirm'}
                </button>
                {/* W9 HARD BLOCK (card 4a39e0fd, binding ruling): a failed
                    statement file locks Confirm — server-enforced too; this
                    names the blocker instead of a mute disabled button. */}
                {view.ingestFailed > 0 && !view.failedFilesOverridden && (
                  <p className="text-xs text-red-700">
                    {it
                      ? 'La conferma è bloccata: uno o più estratti conto non sono stati letti. Vedi le schede file nella sezione Estratti conto — il nostro team è già avvisato.'
                      : 'Confirmation is locked: one or more bank statements could not be read. See the file cards in the Bank statements section — our team has already been notified.'}
                  </p>
                )}
                {/* Name the RIGHT blocker (2026-08-03). No gate blocks confirm
                    any more, so what lands here is the year-coverage step — but
                    the old wording said "the remaining questions above", which
                    points at the categorization queue and sent clients back to
                    a list that was never what was stopping them. */}
                {/* Never render BESIDE the failed-file lock. Both paragraphs
                    used to show at once, and this one said "ONLY the Year
                    coverage section is missing — answer there and you can
                    confirm" while the red line above said confirm was locked by
                    an unreadable file. Answering coverage would NOT have
                    unlocked it. One blocker on screen at a time; the hard block
                    wins because it's the one that actually gates Confirm.
                    (2026-08-12, found on Antonio's QA of card 4a39e0fd.) */}
                {!(view.ingestFailed > 0 && !view.failedFilesOverridden) &&
                  (!view.completeness.can_accept_as_is || view.coverage.unanswered > 0 || view.coverage.incomplete > 0) && (
                  <p className="text-xs text-amber-700">
                    {view.coverage.incomplete > 0
                      ? (it ? 'Hai indicato che un export è incompleto — sostituisci il file, poi potrai confermare.' : 'You marked an export as incomplete — replace the file, then you can confirm.')
                      : view.coverage.unanswered > 0
                        ? (it ? 'Manca solo la sezione “Copertura dell’anno” qui sopra (i mesi non coperti dagli estratti conto) — rispondi lì e potrai confermare.' : 'Only the “Year coverage” section above is missing (the months your statements don\'t cover) — answer there and you can confirm.')
                        : (it ? 'Rispondi prima alle domande rimaste qui sopra — poi potrai confermare.' : 'Answer the remaining questions above first — then you can confirm.')}
                  </p>
                )}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}
