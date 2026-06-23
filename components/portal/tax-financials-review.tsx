'use client'

/**
 * Tax financials review screen (Slice 8). Renders the on-demand financials
 * view: gate checkmarks, P&L + Balance Sheet summary, per-member capital,
 * per-file cards (delete & replace), pattern-grouped questions, Excel
 * download, and the confirm attestation (blocked while gate 6 fails).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

interface Gate { id: number; title: string; status: 'pass' | 'na' | 'fail'; detail: string; blocking: boolean }
interface Member { name: string; pct: number; beginning_capital: number; contributions: number; distributions: number; income_share: number; ending_capital: number }
interface QuestionGroup { group_key: string; label: string; count: number; total: number; direction: 'in' | 'out' | 'mixed'; transaction_ids: string[]; sample: string; ai_lean?: 'business' | 'personal' | 'unsure'; ai_bucket?: string; current_category?: string }
interface Bucket { slug: string; label: string }
interface FileCard { source_file_id: string; bank_name: string; count: number; from: string; to: string }

interface CoverageQuestion { key: string; bank_key: string; kind: string; months: string[]; question: string; answer: 'no_activity' | 'had_activity' | null }

type IncomeAnswer = 'earn_spend' | 'parked_only'
interface CompletenessItem { code: string; severity: 'warn' | 'info'; amount?: number; detail?: string }
interface IncomeQuestionState { required: boolean; foreign_total: number; answer: IncomeAnswer | null }
interface CompletenessSummary { items: CompletenessItem[]; income_question: IncomeQuestionState; can_accept_as_is: boolean }

interface View {
  coverage: { questions: CoverageQuestion[]; unanswered: number; incomplete: number }
  completeness: CompletenessSummary
  draft: {
    pnl: { totalIncome: number; totalCogs: number; grossProfit: number; totalExpenses: number; netIncome: number; totalDistributions: number; totalContributions: number; uncategorizedCount: number }
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
  questions: QuestionGroup[]
  buckets: Bucket[]
  expense_breakdown?: { slug: string; label: string; total: number }[]
  attested: boolean
  files: FileCard[]
}

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
// (uncategorized defaults to business expense in the P&L, so it shows as such.)
const CATEGORY_TO_ANSWER: Record<string, string> = {
  expense: 'business_expense', cogs: 'business_expense', uncategorized: 'business_expense',
  fee: 'bank_fee', distribution: 'personal_spending', income: 'business_income',
  contribution: 'owner_money_in', conversion: 'own_transfer',
}
const activeAnswerOf = (g: QuestionGroup) => CATEGORY_TO_ANSWER[g.current_category ?? 'uncategorized'] ?? 'business_expense'

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function TaxFinancialsReview({ accountId, taxYear, locale }: { accountId: string; taxYear: number; locale: string }) {
  const it = locale === 'it'
  const [view, setView] = useState<View | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [attestChecked, setAttestChecked] = useState(false)
  const [attested, setAttested] = useState(false)
  const [newBucket, setNewBucket] = useState('')
  // P&L expense-category drill-down (Luca's request, dev_task 1bee0ffe).
  const [openCat, setOpenCat] = useState<string | null>(null)
  const [catData, setCatData] = useState<Record<string, CategoryDrill>>({})
  const [catLoading, setCatLoading] = useState<string | null>(null)
  const [catError, setCatError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/tax-financials?account_id=${accountId}&tax_year=${taxYear}`)
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
  }, [accountId, taxYear, it])

  useEffect(() => { void load() }, [load])

  const answer = async (g: QuestionGroup, value: string) => {
    setBusy(g.group_key)
    try {
      const res = await fetch('/api/portal/tax-financials/answer', {
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

  // Toggle a category open and lazy-load its transactions (cached after first open).
  const toggleCategory = async (slug: string) => {
    if (openCat === slug) { setOpenCat(null); return }
    setOpenCat(slug)
    setCatError(null)
    if (catData[slug]) return
    setCatLoading(slug)
    try {
      const res = await fetch(`/api/portal/tax-financials/category-transactions?account_id=${accountId}&tax_year=${taxYear}&bucket=${encodeURIComponent(slug)}`)
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
      const res = await fetch('/api/portal/tax-financials/add-bucket', {
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

  const bulkAnswer = async (groups: QuestionGroup[], value: string) => {
    setBusy('bulk')
    try {
      for (const g of groups) {
        const res = await fetch('/api/portal/tax-financials/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: accountId, tax_year: taxYear, transaction_ids: g.transaction_ids, answer: value }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || (it ? 'Aggiornamento non riuscito — riprova.' : 'Could not update — please try again.'))
        }
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const setBucket = async (g: QuestionGroup, bucket: string) => {
    setBusy(g.group_key)
    try {
      const res = await fetch('/api/portal/tax-financials/set-bucket', {
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
      const res = await fetch(`/api/portal/tax-financials/statement?account_id=${accountId}&tax_year=${taxYear}&source_file_id=${encodeURIComponent(f.source_file_id)}`, { method: 'DELETE' })
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

  const answerCoverage = async (q: CoverageQuestion, value: 'no_activity' | 'had_activity') => {
    setBusy(q.key)
    try {
      const res = await fetch('/api/portal/tax-financials/coverage', {
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

  const answerIncome = async (value: IncomeAnswer) => {
    setBusy('income')
    try {
      const res = await fetch('/api/portal/tax-financials/income-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, tax_year: taxYear, answer: value }),
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
      const res = await fetch('/api/portal/tax-financials/attest', {
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

  const gateIcon = (g: Gate) => g.status === 'pass' ? '✓' : g.status === 'na' ? '—' : '!'
  const gateColor = (g: Gate) => g.status === 'pass' ? 'text-emerald-600 bg-emerald-50' : g.status === 'na' ? 'text-zinc-500 bg-zinc-100' : 'text-amber-700 bg-amber-50'

  const visibleAnswers = useMemo(() => (g: QuestionGroup) => ANSWERS.filter(a => a.directions.includes(g.direction)), [])

  if (loading && !view) return <div className="py-16 text-center text-zinc-500 text-sm">{it ? 'Calcolo dei tuoi numeri…' : 'Computing your numbers…'}</div>

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
        <p className="text-xs text-zinc-500 mt-2">
          {it ? 'Hai sbagliato qualcosa che hai inserito? ' : 'Made a mistake in something you entered? '}
          <a href="/portal/wizard?type=tax" className="font-semibold text-blue-700 underline hover:text-blue-900">
            {it ? 'Modifica le tue informazioni' : 'Edit my information'}
          </a>
          {it ? '. Le tue risposte e le categorie già scelte restano salvate.' : '. Your answers and the categories you already chose stay saved.'}
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {view && (
        <>
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

          {/* Spending review (#2) — grouped into accountant buckets, each merchant
              pre-tagged with the AI's business/personal guess. Everything is set
              to business expense by default (reflected in the P&L above); the
              owner confirms/flips the exceptions (which persist + feed learning)
              and can re-bucket or add a new (shared) category. */}
          {view.questions.length > 0 && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900">
                {it ? 'Le tue spese — già impostate come spese aziendali' : 'Your spending — already set as business expenses'}
              </h2>
              <p className="text-xs text-zinc-500 mt-1 mb-4">
                {it
                  ? 'Le abbiamo raggruppate per categoria e segnalato quelle che sembrano personali. Conferma o correggi: tocca “Personale” su ciò che era tuo (non della società). Il resto lascialo così.'
                  : 'We’ve grouped them by category and flagged the ones that look personal. Confirm or correct: tap “Personal” on anything that was yours (not the company’s). Leave the rest as they are.'}
              </p>
              {(() => {
                const bucketLabel = new Map(view.buckets.map(b => [b.slug, b.label]))
                const order = [...view.buckets.map(b => b.slug), '__unsorted__']
                const byBucket = new Map<string, QuestionGroup[]>()
                for (const g of view.questions) {
                  const key = g.ai_bucket && bucketLabel.has(g.ai_bucket) ? g.ai_bucket : '__unsorted__'
                  if (!byBucket.has(key)) byBucket.set(key, [])
                  byBucket.get(key)!.push(g)
                }
                return order.filter(k => byBucket.has(k)).map(slug => {
                  const groups = byBucket.get(slug)!
                  const label = slug === '__unsorted__' ? (it ? 'Da sistemare' : 'Not yet sorted') : (bucketLabel.get(slug) ?? slug)
                  const outGroups = groups.filter(x => x.direction === 'out')
                  return (
                    <div key={slug} className="mb-5">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label} · {groups.length}</div>
                        {outGroups.length > 1 && (
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-zinc-400">{it ? 'Tutti come:' : 'All as:'}</span>
                            <button
                              disabled={busy !== null}
                              onClick={() => void bulkAnswer(outGroups, 'business_expense')}
                              className="rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-zinc-900 disabled:opacity-50"
                            >{it ? 'Aziendale' : 'Business'}</button>
                            <button
                              disabled={busy !== null}
                              onClick={() => void bulkAnswer(outGroups, 'personal_spending')}
                              className="rounded-full border border-amber-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-amber-700 hover:border-amber-600 disabled:opacity-50"
                            >{it ? 'Personale' : 'Personal'}</button>
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        {groups.map(g => {
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
                        })}
                      </div>
                    </div>
                  )
                })
              })()}
              {/* Add a new bucket — flexible, shared vocabulary (#2). A bucket added
                  here is saved globally and offered to everyone next time. */}
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

          {/* Files */}
          {view.files.length > 0 && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">{it ? 'File caricati' : 'Uploaded files'}</h2>
              <ul className="space-y-2">
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
            </section>
          )}

          {/* Completeness summary + income question (dev_task 95127bb2) —
              translate the checks that didn't fully pass into plain language,
              and (when there's foreign/cross-account movement) require the
              income question before accept-as-is. */}
          {!attested && (view.completeness.items.length > 0 || view.completeness.income_question.required) && (
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

              {view.completeness.income_question.required && (
                <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 sm:p-4">
                  <div className="text-sm font-medium text-zinc-800">
                    {it
                      ? 'Vediamo denaro convertito da un\'altra valuta o spostato da un altro conto. Guadagni o spendi anche direttamente in quell\'altro conto, oppure lo converti soltanto e lo sposti qui?'
                      : 'We can see money converted from another currency or moved from another account. Do you also earn or spend money directly in that other account, or do you only convert it and move it here?'}
                  </div>
                  {view.completeness.income_question.answer === null ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        disabled={busy !== null}
                        onClick={() => void answerIncome('parked_only')}
                        className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                      >
                        {it ? 'Lo converto soltanto e lo sposto qui' : 'I only convert it and move it here'}
                      </button>
                      <button
                        disabled={busy !== null}
                        onClick={() => void answerIncome('earn_spend')}
                        className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                      >
                        {it ? 'Guadagno o spendo anche direttamente lì' : 'I also earn or spend directly there'}
                      </button>
                    </div>
                  ) : view.completeness.income_question.answer === 'earn_spend' ? (
                    <div className="mt-2 text-xs text-amber-800">
                      {it
                        ? 'Ricevuto. Poiché ci sono incassi o spese in un conto che non vediamo, quegli importi vanno nelle dichiarazioni dei soci nel loro Paese. Puoi comunque confermare con ciò che hai — ti ricontattiamo.'
                        : 'Got it. Because there\'s income or spending in an account we don\'t see, those amounts belong on your partners\' home-country returns. You can still confirm with what you have — we\'ll follow up.'}
                      <button
                        disabled={busy !== null}
                        onClick={() => void answerIncome('parked_only')}
                        className="ml-2 underline text-zinc-500 hover:text-zinc-800"
                      >
                        {it ? 'Cambia risposta' : 'Change answer'}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-emerald-700">
                      {it ? '✓ Grazie — registrato.' : '✓ Thanks — recorded.'}
                      <button
                        disabled={busy !== null}
                        onClick={() => void answerIncome('earn_spend')}
                        className="ml-2 underline text-zinc-500 hover:text-zinc-800"
                      >
                        {it ? 'Cambia risposta' : 'Change answer'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Download + Attest */}
          <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 space-y-4">
            <a
              href={`/api/portal/tax-financials/download?account_id=${accountId}&tax_year=${taxYear}`}
              className="inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900"
            >
              {it ? 'Scarica Excel (P&L + Stato Patrimoniale)' : 'Download Excel (P&L + Balance Sheet)'}
            </a>

            {attested ? (
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
                        ? 'Se hai una società estera con soci all\'estero, i redditi guadagnati o spesi su conti che non vediamo possono comunque andare dichiarati nel Paese dei soci.'
                        : 'If you are a foreign-owned company, income earned or spent in accounts we don\'t see may still need to be reported on the owners\' home-country returns.'}
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
                  disabled={!attestChecked || !view.completeness.can_accept_as_is || view.coverage.unanswered > 0 || view.coverage.incomplete > 0 || busy !== null}
                  onClick={() => void attest()}
                  className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
                >
                  {it ? 'Accetto e confermo' : 'Accept and confirm'}
                </button>
                {(!view.completeness.can_accept_as_is || view.coverage.unanswered > 0 || view.coverage.incomplete > 0) && (
                  <p className="text-xs text-amber-700">
                    {view.coverage.incomplete > 0
                      ? (it ? 'Hai indicato che un export è incompleto — sostituisci il file, poi potrai confermare.' : 'You marked an export as incomplete — replace the file, then you can confirm.')
                      : (view.completeness.income_question.required && view.completeness.income_question.answer === null)
                        ? (it ? 'Rispondi prima alla domanda sull\'attività in valuta/altri conti qui sopra — poi potrai confermare.' : 'Answer the question about your foreign / other-account activity above first — then you can confirm.')
                        : (it ? 'Rispondi prima alle domande rimaste qui sopra — poi potrai confermare.' : 'Answer the remaining questions above first — then you can confirm.')}
                  </p>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
