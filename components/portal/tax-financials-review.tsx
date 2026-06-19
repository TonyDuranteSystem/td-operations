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

interface View {
  coverage: { questions: CoverageQuestion[]; unanswered: number; incomplete: number }
  draft: {
    pnl: { totalIncome: number; totalCogs: number; grossProfit: number; totalExpenses: number; netIncome: number; totalDistributions: number; totalContributions: number; uncategorizedCount: number }
    members: Member[]
    beginning_cash: number | null
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
  expense_breakdown?: { label: string; total: number }[]
  attested: boolean
  files: FileCard[]
}

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
                    {view.expense_breakdown!.map(b => (
                      <div key={b.label} className="flex justify-between text-xs text-zinc-400"><dt>{b.label}</dt><dd>−{fmt(b.total)}</dd></div>
                    ))}
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
                <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Cassa iniziale' : 'Beginning cash'}</dt><dd className="font-medium">{view.draft.beginning_cash === null ? '—' : fmt(view.draft.beginning_cash)}</dd></div>
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
                <label className="flex items-start gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={attestChecked} onChange={e => setAttestChecked(e.target.checked)} className="mt-0.5" />
                  <span>
                    {it
                      ? 'Confermo di aver controllato il Conto Economico e lo Stato Patrimoniale e che i numeri corrispondono alla realtà della mia società.'
                      : 'I confirm I have checked the Profit & Loss and Balance Sheet and the numbers reflect my company’s reality.'}
                  </span>
                </label>
                <button
                  disabled={!attestChecked || !view.canConfirm || view.coverage.unanswered > 0 || view.coverage.incomplete > 0 || busy !== null}
                  onClick={() => void attest()}
                  className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
                >
                  {it ? 'Confermo i numeri' : 'Confirm the numbers'}
                </button>
                {(!view.canConfirm || view.coverage.unanswered > 0 || view.coverage.incomplete > 0) && (
                  <p className="text-xs text-amber-700">
                    {view.coverage.incomplete > 0
                      ? (it ? 'Hai indicato che un export è incompleto — sostituisci il file, poi potrai confermare.' : 'You marked an export as incomplete — replace the file, then you can confirm.')
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
