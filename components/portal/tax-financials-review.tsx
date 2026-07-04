'use client'

/**
 * Tax financials review screen (Slice 8). Renders the on-demand financials
 * view: gate checkmarks, P&L + Balance Sheet summary, per-member capital,
 * per-file cards (delete & replace), pattern-grouped questions, Excel
 * download, and the confirm attestation (blocked while gate 6 fails).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'

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
interface QuestionGroup { group_key: string; label: string; count: number; total: number; direction: 'in' | 'out' | 'mixed'; transaction_ids: string[]; sample: string; ai_lean?: 'business' | 'personal' | 'unsure'; ai_bucket?: string; current_category?: string }
interface Bucket { slug: string; label: string }
interface FileCard { source_file_id: string; bank_name: string; count: number; from: string; to: string }

interface CoverageQuestion { key: string; bank_key: string; kind: string; months: string[]; question: string; answer: 'no_activity' | 'had_activity' | null }

interface CompletenessItem { code: string; severity: 'warn' | 'info'; amount?: number; detail?: string }
interface CompletenessSummary { items: CompletenessItem[]; can_accept_as_is: boolean }

interface View {
  coverage: { questions: CoverageQuestion[]; unanswered: number; incomplete: number }
  completeness: CompletenessSummary
  draft: {
    pnl: { totalIncome: number; totalCogs: number; grossProfit: number; totalExpenses: number; netIncome: number; totalDistributions: number; totalContributions: number; uncategorizedCount: number; uncategorizedTotal: number }
    members: Member[]
    beginning_cash: number | null
    beginning_cash_source: 'prior_return' | 'statements' | null
    ending_cash: number
    total_assets: number
    total_liabilities: number
    ending_capital_total: number
    notes: string[]
  }
  gates: Gate[]
  canConfirm: boolean
  transactionCount: number
  /** Per-file ingest jobs still running for this account+year. While > 0 the
   *  P&L is incomplete — show "still preparing", not a misleading $0, and block
   *  attestation. */
  ingestPending: number
  /** Statement files that couldn't be read (unreadable/merged or failed). */
  ingestFailed: number
  questions: QuestionGroup[]
  buckets: Bucket[]
  expense_breakdown?: { slug: string; label: string; total: number }[]
  attested: boolean
  files: FileCard[]
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
  residence_country?: string | null
  residence_on_file?: boolean
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

const ANSWERS = [
  { value: 'business_expense', directions: ['out', 'mixed'], en: 'Business expense', it: 'Spesa aziendale' },
  { value: 'personal_spending', directions: ['out', 'mixed'], en: 'Personal (owner) spending', it: 'Spesa personale (del socio)' },
  { value: 'business_income', directions: ['in', 'mixed'], en: 'Business income / a sale', it: 'Incasso aziendale / vendita' },
  { value: 'owner_money_in', directions: ['in', 'mixed'], en: 'My own money put in', it: 'Soldi miei messi nella società' },
  { value: 'own_transfer', directions: ['in', 'out', 'mixed'], en: 'Transfer between my own accounts', it: 'Trasferimento tra i miei conti' },
  { value: 'bank_fee', directions: ['out', 'mixed'], en: 'Bank / platform fee', it: 'Commissione bancaria' },
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
  contribution: 'owner_money_in', conversion: 'own_transfer',
}
const activeAnswerOf = (g: QuestionGroup): string | null => {
  const cat = g.current_category ?? 'uncategorized'
  return cat === 'uncategorized' ? null : (CATEGORY_TO_ANSWER[cat] ?? null)
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
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  // P&L expense-category drill-down (Luca's request, dev_task 1bee0ffe).
  const [openCat, setOpenCat] = useState<string | null>(null)
  // Triage tiers (2026-07-03): which collapsed review sections are open.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set())
  // Location-period triage (Phase 2b): pending confirm dialog + one-by-one filter.
  const [periodConfirm, setPeriodConfirm] = useState<{ period: PresencePeriodView; choice: 'business' | 'personal' } | null>(null)
  const [periodFilter, setPeriodFilter] = useState<{ label: string; keys: Set<string> } | null>(null)
  // Period-answer failures render INSIDE the period section (2026-07-04:
  // Antonio's rejected taps surfaced only in the far-away top banner — the
  // buttons looked dead; a rejection must be loud where the click happened).
  const [periodError, setPeriodError] = useState<string | null>(null)
  const [catData, setCatData] = useState<Record<string, CategoryDrill>>({})
  const [catLoading, setCatLoading] = useState<string | null>(null)
  const [catError, setCatError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}?account_id=${accountId}&tax_year=${taxYear}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile caricare i dati — riprova.' : 'Could not load your financials — please try again.'))
      }
      const v: View = await res.json()
      setView(v)
      setAttested(v.attested) // server truth — a data change resets it
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
    const t = setInterval(() => { void load() }, active ? 20000 : retryWait!)
    return () => clearInterval(t)
  }, [view, load])

  const answer = async (g: QuestionGroup, value: string) => {
    setBusy(g.group_key)
    try {
      const res = await fetch(`${API}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, transaction_ids: g.transaction_ids, answer: value }),
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

  const undoPeriodAnswer = async (batchId: string) => {
    setBusy(`period-undo-${batchId}`)
    try {
      const res = await fetch(`${API}/period-answer/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batchId }),
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
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const deleteFile = async (f: FileCard) => {
    const msg = it
      ? `Eliminare il file di ${f.bank_name} (${f.count} transazioni)? Potrai caricarne uno nuovo subito dopo.`
      : `Delete the ${f.bank_name} file (${f.count} transactions)? You can upload a new one right after.`
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

  // Upload one statement file; throws on failure with the server's message.
  const uploadOneStatement = async (file: File, bank: string): Promise<void> => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('account_id', accountId)
    fd.append('tax_year', String(taxYear))
    fd.append('bank_name', bank)
    fd.append('account_kind', uploadKind)
    const res = await fetch(`${API}/upload`, { method: 'POST', body: fd })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(d.error || (it ? 'Caricamento non riuscito — riprova.' : 'Upload failed — please try again.'))
    }
  }

  // Upload one or more files SEQUENTIALLY (one at a time), refreshing the P&L
  // after each so the numbers grow as files land. Per-file failures are
  // collected and surfaced without aborting the rest of the batch.
  const uploadStatements = async (files: File[]) => {
    const bank = uploadBank.trim()
    if (!bank) { setError(it ? 'Indica il nome della banca prima di caricare.' : 'Enter the bank name before uploading.'); return }
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
          await uploadOneStatement(files[i], bank)
          ok++
          await load()
        } catch (e) {
          failures.push(`${files[i].name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setUploadBank('')
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
  const renderStatements = () => {
    if (!view) return null
    return (
      <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'Estratti conto' : 'Bank statements'}</h2>
        {view.files.length > 0 && (
          <ul className="space-y-2 mb-4">
            {view.files.map(f => (
              <li key={f.source_file_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2">
                <div className="text-sm text-zinc-800">
                  <span className="font-medium">{f.bank_name}</span>
                  <span className="text-zinc-500 text-xs ml-2">{f.count} {it ? 'transazioni' : 'transactions'} · {f.from} → {f.to}</span>
                </div>
                <button
                  disabled={busy !== null}
                  onClick={() => void deleteFile(f)}
                  className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {it ? 'Elimina' : 'Delete'}
                </button>
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={uploadBank}
              onChange={e => setUploadBank(e.target.value)}
              placeholder={it ? 'Nome della banca (es. Mercury)' : 'Bank name (e.g. Mercury)'}
              disabled={busy !== null}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50"
            />
            <select
              value={uploadKind}
              onChange={e => setUploadKind(e.target.value)}
              disabled={busy !== null}
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
                disabled={busy !== null}
                className="hidden"
                onChange={e => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (files.length) void uploadStatements(files)
                }}
              />
            </label>
          </div>
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
              <span className="block text-xs text-amber-700 mt-1">{view.ingestFailed} file(s) could not be read — delete and re-upload them, or generate without them.</span>
            )}
          </div>
          <button
            type="button"
            disabled={busy !== null || processing || view.transactionCount === 0}
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
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
          {it ? `Conto Economico e Stato Patrimoniale ${taxYear}` : `Profit & Loss and Balance Sheet ${taxYear}`}
        </h1>
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
            disabled={busy !== null || view.ingestPending > 0}
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
                    <div className="text-sm font-medium text-zinc-800">{g.title}</div>
                    <div className="text-xs text-zinc-500">{g.detail}</div>
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
              </dl>
            </section>
          </div>

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
          {isStaff && ((view.periods?.length ?? 0) > 0 || (view.period_answers?.length ?? 0) > 0) && (
            <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 sm:p-5">
              <h3 className="text-sm font-bold text-indigo-900 mb-1">
                🌍 {it ? 'Periodi fuori sede rilevati' : 'Time away from home base detected'}
              </h3>
              <p className="text-xs text-zinc-600 mb-3">
                {view.residence_on_file
                  ? (it
                    ? `Residenza fiscale registrata: ${locLabel(view.residence_country ?? '', it)}. Le spese fatte lì restano nella revisione normale; per i periodi all'estero basta UNA risposta.`
                    : `Fiscal residence on file: ${locLabel(view.residence_country ?? '', it)}. Spending there stays in the normal review; each period away needs just ONE answer.`)
                  : (it
                    ? 'Nessuna residenza fiscale registrata nel CRM per questo cliente — mostriamo tutti i periodi rilevati.'
                    : 'No fiscal residence on file in the CRM for this client — showing every detected period.')}
              </p>
              {periodError && (
                <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                  ⚠ {periodError}
                </div>
              )}
              <div className="space-y-3">
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
                        {p.top_merchants.length > 0 && (
                          <span className="text-zinc-500"> ({it ? 'principali' : 'top merchants'}: {p.top_merchants.join(', ')})</span>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          disabled={busy !== null}
                          onClick={() => setPeriodConfirm({ period: p, choice: 'business' })}
                          className="rounded-full border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {it ? 'Tutto aziendale' : 'All business'}
                        </button>
                        <button
                          disabled={busy !== null}
                          onClick={() => setPeriodConfirm({ period: p, choice: 'personal' })}
                          className="rounded-full border border-amber-500 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                        >
                          {it ? 'Tutto personale' : 'All personal'}
                        </button>
                        <button
                          disabled={busy !== null}
                          onClick={() => setPeriodFilter({ label: `${periodLabel(p, it)} · ${fmtDay(p.start, it)} – ${fmtDay(p.end, it)}`, keys: new Set(p.group_keys) })}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                        >
                          {it ? 'Controllo una per una' : 'Review one-by-one'}
                        </button>
                      </div>
                    </div>
                  )
                })}
                {(view.period_answers ?? []).map(b => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                    <span>
                      ✓ {b.actor_role === 'client'
                        ? (it ? 'Il cliente ha attestato' : 'Client attested')
                        : (it ? 'Registrato dallo staff su indicazione del cliente' : 'Staff booked on client\'s instruction')}
                      {': '}
                      <strong className="text-zinc-800">{b.loc_codes.map(c => locLabel(c, it)).join(' / ')} {fmtDay(b.period_start, it)} – {fmtDay(b.period_end, it)} = {b.choice === 'business' ? (it ? 'aziendale' : 'business') : (it ? 'personale' : 'personal')}</strong>
                      {` (${b.row_count} ${it ? 'righe' : 'rows'}, $${fmt(b.dollar_total)})`}
                    </span>
                    <button
                      disabled={busy !== null}
                      onClick={() => void undoPeriodAnswer(b.id)}
                      className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-600 hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                    >
                      {it ? 'Annulla' : 'Undo'}
                    </button>
                  </div>
                ))}
              </div>
            </section>
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
                    disabled={busy !== null}
                    className="rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900"
                  >
                    {it ? 'Annulla' : 'Cancel'}
                  </button>
                  <button
                    onClick={() => void confirmPeriodAnswer()}
                    disabled={busy !== null}
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
                const inFilter = (g: QuestionGroup) => !periodFilter || periodFilter.keys.has(g.group_key)
                const needs = view.questions.filter(g => inFilter(g) && (g.current_category ?? 'uncategorized') === 'uncategorized')
                const booked = view.questions.filter(g => inFilter(g) && (g.current_category ?? 'uncategorized') !== 'uncategorized')
                const glance = booked.filter(g => g.ai_lean === 'personal' || g.ai_lean === 'unsure' || !g.ai_lean)
                const autoBooked = booked.filter(g => g.ai_lean === 'business')
                const needsIn = needs.filter(g => g.direction !== 'out')
                const needsOut = needs.filter(g => g.direction === 'out')

                const renderCard = (g: QuestionGroup) => {
                  const lean = g.ai_lean === 'personal'
                    ? { txt: it ? 'Sembra personale' : 'Looks personal', cls: 'text-amber-700 bg-amber-50' }
                    : g.ai_lean === 'business'
                      ? { txt: it ? 'Sembra aziendale' : 'Looks business', cls: 'text-emerald-700 bg-emerald-50' }
                      : { txt: it ? 'Da controllare' : 'Please check', cls: 'text-zinc-500 bg-zinc-100' }
                  return (
                    <div key={g.group_key} className="rounded-lg border border-zinc-200 bg-white p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="text-sm font-medium text-zinc-800">{g.label}</div>
                        <div className="text-xs text-zinc-500">{g.count}× · {fmt(g.total)}</div>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${lean.cls}`}>{lean.txt}</span>
                        <select
                          value={g.ai_bucket ?? ''}
                          disabled={busy !== null}
                          onChange={e => void setBucket(g, e.target.value)}
                          className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 disabled:opacity-50"
                        >
                          <option value="">{it ? '— categoria —' : '— category —'}</option>
                          {view.buckets.map(b => <option key={b.slug} value={b.slug}>{b.label}</option>)}
                        </select>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-zinc-400">{it ? 'Impostato come:' : 'Set as:'}</span>
                        {visibleAnswers(g).map(a => {
                          const selected = a.value === activeAnswerOf(g)
                          return (
                            <button
                              key={a.value}
                              disabled={busy !== null || selected}
                              onClick={() => void answer(g, a.value)}
                              aria-pressed={selected}
                              className={selected
                                ? 'rounded-full border border-blue-600 bg-blue-600 px-3 py-1 text-xs font-semibold text-white'
                                : 'rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50'}
                            >
                              {selected ? '✓ ' : ''}{it ? a.it : a.en}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                }

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
                        {it
                          ? `rispondere alle voci in “Serve una tua decisione” (${needs.length}) — un tocco ciascuna.`
                          : `answer the items under “Needs your decision” (${needs.length}) — one tap each.`}
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

                    {/* TIER 1 — Needs your decision (the work queue, always expanded). */}
                    {needs.length > 0 ? (
                      <div className="mb-5 rounded-xl border-2 border-amber-300 bg-amber-50/50 p-3 sm:p-4">
                        <h3 className="text-sm font-bold text-amber-900 mb-2">
                          🖐 {it ? `Serve una tua decisione · ${needs.length}` : `Needs your decision · ${needs.length}`}
                        </h3>
                        {needsIn.length > 0 && (
                          <div className="mb-3">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-1.5">{it ? 'Soldi in entrata' : 'Money in'}</div>
                            <div className="space-y-2">{needsIn.map(renderCard)}</div>
                          </div>
                        )}
                        {needsOut.length > 0 && (
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-1.5">{it ? 'Spese' : 'Spending'}</div>
                            <div className="space-y-2">{needsOut.map(renderCard)}</div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mb-5 rounded-xl border-2 border-emerald-300 bg-emerald-50 px-4 py-4 text-sm font-semibold text-emerald-900">
                        ✓ {it ? 'Tutto registrato — non serve nessuna decisione.' : 'All booked — nothing needs your decision.'}
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
                <input
                  value={newBucket}
                  onChange={e => setNewBucket(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void addBucket() }}
                  placeholder={it ? 'Aggiungi categoria…' : 'Add a category…'}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
                />
                <button
                  disabled={busy !== null || newBucket.trim().length < 2}
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
                          disabled={busy !== null}
                          onClick={() => void answerCoverage(q, 'no_activity')}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                        >
                          {it ? 'No — nessuna attività in quei mesi' : 'No — no activity in those months'}
                        </button>
                        <button
                          disabled={busy !== null}
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
                    <li>
                      {it
                        ? 'Non sei ancora pronto? Puoi modificare le tue informazioni o caricare altri estratti conto qui sopra, invece di confermare.'
                        : 'Not ready yet? You can edit your information or upload more statements above instead of confirming.'}
                    </li>
                  </ul>
                </div>
                <label className="flex items-start gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={attestChecked} onChange={e => setAttestChecked(e.target.checked)} className="mt-0.5" />
                  <span>
                    {it
                      ? 'Confermo di aver controllato il Conto Economico e lo Stato Patrimoniale e accetto questi numeri così come sono, sulla base delle informazioni che ho fornito. Capisco che eventuali conti o redditi non comunicati sono una mia responsabilità.'
                      : 'I confirm I have checked the Profit & Loss and Balance Sheet and I accept these numbers as they are, based on the information I have provided. I understand that any accounts or income I have not reported are my responsibility.'}
                  </span>
                </label>
                <button
                  disabled={!attestChecked || !view.completeness.can_accept_as_is || view.coverage.unanswered > 0 || view.coverage.incomplete > 0 || view.ingestPending > 0 || busy !== null}
                  onClick={() => void attest()}
                  className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
                >
                  {it ? 'Accetto e confermo' : 'Accept and confirm'}
                </button>
                {(!view.completeness.can_accept_as_is || view.coverage.unanswered > 0 || view.coverage.incomplete > 0) && (
                  <p className="text-xs text-amber-700">
                    {view.coverage.incomplete > 0
                      ? (it ? 'Hai indicato che un export è incompleto — sostituisci il file, poi potrai confermare.' : 'You marked an export as incomplete — replace the file, then you can confirm.')
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
