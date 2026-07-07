'use client'

/**
 * Validation Mode panel (V1, staff-only — 2026-07-06).
 *
 * Renders the ValidationBreakdown the workspace GET computes in the SAME
 * engine pass as the report. If the runtime invariant failed (breakdown ≢
 * draft), this component shows ONLY the error — the feature refuses to
 * explain numbers it cannot reproduce.
 */

import { useState } from 'react'

// Mirrors lib/tax/validation-breakdown.ts (server shapes; client-safe copy).
interface CurrencySlice { currency: string; count: number; sum_original: number; rate: number | null; missing_rate: boolean; sum_usd: number }
interface CompositionLine {
  key: string; label: string; total_usd: number; count: number
  by_currency: CurrencySlice[]
  top_counterparties: Array<{ label: string; count: number; total_usd: number }>
  related_party: { count: number; total_usd: number }
  refunds?: { count: number; total_usd: number }
}
interface BsDerivation { key: string; label: string; value: number | null; terms: Array<{ label: string; value: number | null }>; note?: string }
export interface ValidationBreakdownView {
  pnl_lines: CompositionLine[]
  bs_derivations: BsDerivation[]
  provenance: Array<{ class: string; label: string; count: number; total_abs_usd: number }>
  exclusions: { conversions: { count: number; total_abs_usd: number }; unclassified: { count: number; total_usd: number }; missing_rate_currencies: string[] }
  related_party: { count: number; total_abs_usd: number; top_counterparties: Array<{ label: string; count: number; total_usd: number }> }
  policy_inputs: {
    prior_return: { case: string; status: string; note: string | null } | null
    beginning_cash_source: string | null
    ownership_sources: Array<{ name: string; pct: number | null; source: string }>
    fx_rates_used: Array<{ currency: string; rate: number }>
  }
  invariant: { ok: boolean; mismatches: Array<{ line: string; breakdown: number; draft: number }> }
}

interface DrillMerchant { merchant: string; count: number; total: number; transactions: Array<{ id: string; date: string; description: string; amount: number }> }

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const PRIOR_CASE_LABELS: Record<string, string> = {
  first_year: 'First year — no prior return can exist',
  never_filed: 'No prior return was ever filed (declared)',
  we_filed: 'We filed the prior return',
  filed_elsewhere: 'Prior return filed elsewhere (client upload)',
}

export default function ValidationBreakdown({ validation, api }: { validation: ValidationBreakdownView; api: string }) {
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [drill, setDrill] = useState<Record<string, DrillMerchant[] | 'loading'>>({})

  const loadDrill = async (section: 'income' | 'distribution') => {
    if (drill[section]) return
    setDrill(d => ({ ...d, [section]: 'loading' }))
    try {
      const res = await fetch(`${api}/category-transactions?section=${section}`)
      const data = await res.json()
      setDrill(d => ({ ...d, [section]: (data.merchants ?? []) as DrillMerchant[] }))
    } catch {
      setDrill(d => ({ ...d, [section]: [] }))
    }
  }

  if (!validation.invariant.ok) {
    return (
      <section className="rounded-xl border border-red-300 bg-red-50 p-4 sm:p-5">
        <h2 className="text-sm font-bold text-red-900">Validation mode cannot verify these numbers</h2>
        <p className="mt-1 text-xs text-red-800">
          The independent breakdown does not reproduce the report — this is an engine bug, not a data problem. Do not rely on the report until it is resolved.
        </p>
        <ul className="mt-2 space-y-1 text-xs text-red-800">
          {validation.invariant.mismatches.map(m => (
            <li key={m.line}>{m.line}: breakdown {fmt(m.breakdown)} ≠ report {fmt(m.draft)}</li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-900">How these numbers were made</h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Every figure below is recomputed independently from the same transactions and cross-checked against the report — all lines match exactly. ✓
        </p>

        {/* P&L compositions */}
        <ul className="mt-3 divide-y divide-indigo-100">
          {validation.pnl_lines.map(l => {
            const open = openLine === l.key
            const drillSection = l.key === 'income' ? 'income' : l.key === 'distributions' ? 'distribution' : null
            const d = drillSection ? drill[drillSection] : undefined
            return (
              <li key={l.key} className="py-2">
                <button
                  type="button"
                  onClick={() => { setOpenLine(open ? null : l.key); if (!open && drillSection) void loadDrill(drillSection) }}
                  className="flex w-full items-center justify-between gap-2 text-sm"
                  aria-expanded={open}
                >
                  <span className="font-medium text-zinc-800">{l.label} <span className="text-zinc-400">· {l.count} rows</span></span>
                  <span className="font-semibold text-zinc-900">{fmt(l.total_usd)} {open ? '▲' : '▼'}</span>
                </button>
                {open && (
                  <div className="mt-2 space-y-2 text-xs text-zinc-600">
                    <div>
                      <div className="font-medium text-zinc-700">By currency</div>
                      <table className="mt-1 w-full text-left">
                        <thead><tr className="text-zinc-400"><th className="font-normal">Currency</th><th className="font-normal">Rows</th><th className="font-normal">Original</th><th className="font-normal">IRS rate</th><th className="font-normal text-right">USD</th></tr></thead>
                        <tbody>
                          {l.by_currency.map(c => (
                            <tr key={c.currency} className={c.missing_rate ? 'text-amber-700' : ''}>
                              <td>{c.currency}</td>
                              <td>{c.count}</td>
                              <td>{fmt(c.sum_original)}</td>
                              <td>{c.currency === 'USD' ? '—' : c.missing_rate ? 'MISSING — shown unconverted' : `÷ ${c.rate}`}</td>
                              <td className="text-right">{fmt(c.sum_usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {l.refunds && l.refunds.count > 0 && (
                      <div>Includes {l.refunds.count} refund(s) reducing the line by {fmt(-l.refunds.total_usd)} (contra-expense).</div>
                    )}
                    {l.related_party.count > 0 && (
                      <div className="text-amber-700 font-medium">⚑ {l.related_party.count} related-party transaction(s) totalling {fmt(l.related_party.total_usd)} inside this line.</div>
                    )}
                    <div>
                      <div className="font-medium text-zinc-700">Largest counterparties</div>
                      <ul className="mt-0.5">
                        {l.top_counterparties.map(c => <li key={c.label}>{c.label} — {c.count}× · {fmt(c.total_usd)}</li>)}
                      </ul>
                    </div>
                    {drillSection && (
                      <div>
                        <div className="font-medium text-zinc-700">All transactions</div>
                        {d === 'loading' || d === undefined ? <div className="text-zinc-400">Loading…</div> : (
                          <ul className="mt-0.5 max-h-48 overflow-y-auto">
                            {(d as DrillMerchant[]).map(m => (
                              <li key={m.merchant}>{m.merchant} — {m.count}× · {fmt(m.total)}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {/* Balance-sheet derivations */}
      <section className="rounded-xl border border-indigo-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-900 mb-2">Balance sheet — where each figure comes from</h2>
        <ul className="space-y-2 text-xs text-zinc-600">
          {validation.bs_derivations.map(b => (
            <li key={b.key}>
              <div className="flex justify-between text-sm">
                <span className="font-medium text-zinc-800">{b.label}</span>
                <span className="font-semibold text-zinc-900">{b.value === null ? '—' : fmt(b.value)}</span>
              </div>
              <ul className="mt-0.5 pl-3 border-l border-zinc-100">
                {b.terms.map((t, i) => <li key={i}>{t.label}{t.value !== null ? `: ${fmt(t.value)}` : ''}</li>)}
              </ul>
              {b.note && <div className="mt-0.5 text-amber-700">{b.note}</div>}
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Provenance */}
        <section className="rounded-xl border border-indigo-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Who booked the transactions</h2>
          <ul className="space-y-1 text-xs text-zinc-600">
            {validation.provenance.map(p => (
              <li key={p.class} className="flex justify-between">
                <span>{p.label}</span>
                <span>{p.count} rows · {fmt(p.total_abs_usd)}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Exclusions */}
        <section className="rounded-xl border border-indigo-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Deliberately excluded from totals</h2>
          <ul className="space-y-1 text-xs text-zinc-600">
            <li className="flex justify-between"><span>Internal transfers / conversions</span><span>{validation.exclusions.conversions.count} rows · {fmt(validation.exclusions.conversions.total_abs_usd)}</span></li>
            <li className="flex justify-between"><span>Unclassified (shown in red above)</span><span>{validation.exclusions.unclassified.count} rows · {fmt(validation.exclusions.unclassified.total_usd)}</span></li>
            {validation.exclusions.missing_rate_currencies.length > 0 && (
              <li className="text-amber-700">No IRS rate on file for: {validation.exclusions.missing_rate_currencies.join(', ')} — those amounts are unconverted.</li>
            )}
          </ul>
        </section>

        {/* Policy inputs */}
        <section className="rounded-xl border border-indigo-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Answers that shaped these numbers</h2>
          <ul className="space-y-1 text-xs text-zinc-600">
            <li>
              <span className="font-medium text-zinc-700">Prior return: </span>
              {validation.policy_inputs.prior_return
                ? `${PRIOR_CASE_LABELS[validation.policy_inputs.prior_return.case] ?? validation.policy_inputs.prior_return.case} (${validation.policy_inputs.prior_return.status})`
                : 'No answer on file yet'}
            </li>
            <li>
              <span className="font-medium text-zinc-700">Beginning cash source: </span>
              {validation.policy_inputs.beginning_cash_source === 'prior_return' ? 'prior-year return (Schedule L)'
                : validation.policy_inputs.beginning_cash_source === 'statements' ? "bank statements' opening balances"
                : 'unresolved — assumed 0'}
            </li>
            <li>
              <span className="font-medium text-zinc-700">Ownership: </span>
              {validation.policy_inputs.ownership_sources.length === 0 ? 'no members resolved'
                : validation.policy_inputs.ownership_sources.map(o => `${o.name} ${o.pct ?? '?'}% (${o.source.replace('_', ' ')})`).join(' · ')}
            </li>
            {validation.policy_inputs.fx_rates_used.length > 0 && (
              <li>
                <span className="font-medium text-zinc-700">IRS yearly-average rates applied: </span>
                {validation.policy_inputs.fx_rates_used.map(f => `${f.currency} ÷ ${f.rate}`).join(' · ')}
              </li>
            )}
          </ul>
        </section>

        {/* Related party — OWNERS EXCLUDED (2026-07-07, Dynamiq incident:
            members' money is equity, shown in the capital section; only
            declared related entities / non-owner flagged parties belong here). */}
        <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Related-party transactions (non-owner)</h2>
          <p className="text-[11px] text-zinc-500 mb-2">Members&apos; own movements are NOT listed here — they are owner draws/contributions, shown under Members&apos; capital.</p>
          {validation.related_party.count === 0 ? (
            <p className="text-xs text-zinc-500">None flagged in this workspace.</p>
          ) : (
            <div className="text-xs text-zinc-600 space-y-1">
              <div className="flex justify-between font-medium text-zinc-800">
                <span>Total flagged</span>
                <span>{validation.related_party.count} rows · {fmt(validation.related_party.total_abs_usd)}</span>
              </div>
              <ul>
                {validation.related_party.top_counterparties.map(c => (
                  <li key={c.label} className="flex justify-between"><span>{c.label}</span><span>{c.count}× · {fmt(c.total_usd)}</span></li>
                ))}
              </ul>
              <p className="text-amber-700">Cross-check these against the return&apos;s related-party disclosures — misreported related-party amounts carry heavy penalties.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
