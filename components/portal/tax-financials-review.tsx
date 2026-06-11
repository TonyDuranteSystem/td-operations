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
interface QuestionGroup { group_key: string; label: string; count: number; total: number; direction: 'in' | 'out' | 'mixed'; transaction_ids: string[]; sample: string }
interface FileCard { source_file_id: string; bank_name: string; count: number; from: string; to: string }

interface View {
  draft: {
    pnl: { totalIncome: number; totalCogs: number; totalExpenses: number; netIncome: number; totalDistributions: number; totalContributions: number; uncategorizedCount: number }
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

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function TaxFinancialsReview({ accountId, taxYear, locale }: { accountId: string; taxYear: number; locale: string }) {
  const it = locale === 'it'
  const [view, setView] = useState<View | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [attestChecked, setAttestChecked] = useState(false)
  const [attested, setAttested] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/tax-financials?account_id=${accountId}&tax_year=${taxYear}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (it ? 'Impossibile caricare i dati — riprova.' : 'Could not load your financials — please try again.'))
      }
      setView(await res.json())
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
                <div className="flex justify-between"><dt className="text-zinc-500">{it ? 'Spese operative' : 'Operating expenses'}</dt><dd className="font-medium">−{fmt(view.draft.pnl.totalExpenses)}</dd></div>
                <div className="flex justify-between border-t border-zinc-100 pt-1.5"><dt className="font-semibold text-zinc-900">{it ? 'Utile netto' : 'Net income'}</dt><dd className="font-semibold">{fmt(view.draft.pnl.netIncome)}</dd></div>
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

          {/* Questions */}
          {view.questions.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-zinc-900">
                {it ? `${view.draft.pnl.uncategorizedCount} movimenti hanno bisogno di una tua risposta` : `${view.draft.pnl.uncategorizedCount} transactions need your answer`}
              </h2>
              <p className="text-xs text-zinc-500 mt-1 mb-4">
                {it ? 'Una risposta copre tutti i movimenti dello stesso tipo.' : 'One answer covers every transaction of the same kind.'}
              </p>
              <div className="space-y-4">
                {view.questions.map(g => (
                  <div key={g.group_key} className="rounded-lg border border-zinc-200 bg-white p-3 sm:p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="text-sm font-medium text-zinc-800">{g.label}</div>
                      <div className="text-xs text-zinc-500">{g.count}× · {it ? 'totale' : 'total'} {fmt(g.total)}</div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {visibleAnswers(g).map(a => (
                        <button
                          key={a.value}
                          disabled={busy !== null}
                          onClick={() => void answer(g, a.value)}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-900 hover:text-zinc-900 disabled:opacity-50"
                        >
                          {it ? a.it : a.en}
                        </button>
                      ))}
                    </div>
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
                  disabled={!attestChecked || !view.canConfirm || busy !== null}
                  onClick={() => void attest()}
                  className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
                >
                  {it ? 'Confermo i numeri' : 'Confirm the numbers'}
                </button>
                {!view.canConfirm && (
                  <p className="text-xs text-amber-700">
                    {it ? 'Rispondi prima alle domande rimaste qui sopra — poi potrai confermare.' : 'Answer the remaining questions above first — then you can confirm.'}
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
