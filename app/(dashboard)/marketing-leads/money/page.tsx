import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { getMarketingSetting, listCommissionTerms, listTeams } from "@/lib/marketing/settings"
import { listTeamSales } from "@/lib/marketing/sales-server"
import { canPayOut, formatMoney, saleStatusLabel, totalsByCurrency } from "@/lib/marketing/sales"
import { formatWhen } from "@/lib/marketing/lead-view"
import { SaleActions, TermsForm } from "./money-controls"

export const dynamic = "force-dynamic"

/**
 * TD Marketing — Money (Antonio's view; dev job 9aec66fa): what came in, TD's share, what is owed to the seller's company, what was paid out,
 * the split in force for each kind of sale, and every sale with "Apply today's split" / "Mark as paid". Totals are per currency. Admin only (strict check).
 */
export default async function MarketingMoneyAdmin({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const sp = await searchParams
  const teams = await listTeams()
  const team = teams.find(t => t.id === sp.team) ?? teams.find(t => t.status === "active") ?? teams[0] ?? null
  if (!team) return <div className="p-6"><h1 className="text-2xl font-semibold">Money</h1><p className="mt-2 text-sm text-slate-600">There is no team yet.</p></div>
  const db = leadDb()
  const [sales, terms, kinds] = await Promise.all([
    listTeamSales(db, team.id, { limit: 1000 }),
    listCommissionTerms(team.id),
    getMarketingSetting("sale_kinds", team.id) as Promise<{ key: string; label: string }[]>,
  ])
  const ids = Array.from(new Set(sales.map(s => s.lead_id)))
  const { data: leadRows } = ids.length ? await db.from("marketing_leads").select("id, full_name, email, phone").in("id", ids) : { data: [] }
  const names = new Map(((leadRows ?? []) as { id: string; full_name: string | null; email: string | null; phone: string | null }[]).map(l => [l.id, l.full_name || l.email || l.phone || "Unnamed lead"]))
  const totals = totalsByCurrency(sales)
  const flagged = sales.filter(s => s.needs_attention)
  const now = Date.now()
  const kindLabel = (k: string) => kinds.find(x => x.key === k)?.label ?? k
  const card = "rounded-xl border bg-white p-5"
  return (
    <div className="space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">Money</h1><p className="text-sm text-slate-500">Team <b>{team.name}</b>. Each amount is in its own currency; nothing is added across currencies.</p></div>
      {teams.length > 1 && (
        <nav aria-label="Teams" className="flex flex-wrap gap-2">
          {teams.map(t => <Link key={t.id} href={`/marketing-leads/money?team=${t.id}`} className={`rounded-full border px-3 py-1 text-xs ${t.id === team.id ? "border-slate-900 bg-slate-900 text-white" : "bg-white text-slate-600"}`}>{t.name}</Link>)}
        </nav>
      )}

      {flagged.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" aria-label="Needs your attention">
          <h2 className="font-semibold text-amber-900">Needs your attention</h2>
          <ul className="mt-2 space-y-1">{flagged.map(s => <li key={s.id}><b>{names.get(s.lead_id) ?? "Lead"}</b> · {formatMoney(s.amount_cents, s.currency)} — {s.needs_attention}</li>)}</ul>
        </section>
      )}

      {totals.length === 0 ? <p className={`${card} text-sm text-slate-600`}>No sales yet.</p> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {totals.map(t => (
            <section key={t.currency} className={card} aria-label={`Totals in ${t.currency}`}>
              <h2 className="text-sm font-semibold text-slate-600">{t.currency}</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><dt className="text-slate-500">Received</dt><dd className="text-xl font-semibold">{formatMoney(t.receivedCents, t.currency)}</dd></div>
                <div><dt className="text-slate-500">TD share</dt><dd className="text-xl font-semibold">{formatMoney(t.tdCents, t.currency)}</dd></div>
                <div><dt className="text-slate-500">Owed to the seller&apos;s company</dt><dd className="font-medium">{formatMoney(t.owedToSellerCents, t.currency)}</dd></div>
                <div><dt className="text-slate-500">Already paid out</dt><dd className="font-medium">{formatMoney(t.paidOutCents, t.currency)}</dd></div>
              </dl>
              {t.unsetCount > 0 && <p className="mt-3 text-xs text-amber-800">{t.unsetCount} paid sale{t.unsetCount === 1 ? "" : "s"} without a split (terms not set). Set the split below, then press “Apply today&apos;s split” on each.</p>}
              {t.openLinks > 0 && <p className="mt-1 text-xs text-slate-500">{t.openLinks} link{t.openLinks === 1 ? "" : "s"} sent, not paid yet.</p>}
              {t.refundedCount > 0 && <p className="mt-1 text-xs text-slate-500">{t.refundedCount} refunded sale{t.refundedCount === 1 ? "" : "s"} (both shares removed).</p>}
            </section>
          ))}
        </div>
      )}

      <section className={card} aria-label="Terms">
        <h2 className="text-sm font-semibold text-slate-600">The split in force</h2>
        <p className="mt-1 text-xs text-slate-500">A new split applies to payment links made from now on. A sale keeps the split it was made under.</p>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Kind of sale</th><th className="pr-4">Seller</th><th className="pr-4">TD</th><th>Since</th></tr></thead>
          <tbody className="divide-y">
            {kinds.map(k => {
              const t = terms.filter(x => x.kind === k.key && new Date(x.effective_from).getTime() <= now && x.person_ref === "team").sort((a, b) => +new Date(b.effective_from) - +new Date(a.effective_from))[0]
              return <tr key={k.key}><td className="py-2 pr-4">{k.label}</td>{t ? <><td className="pr-4">{t.seller_pct}%</td><td className="pr-4">{t.td_pct}%</td><td className="text-slate-500">{formatWhen(t.effective_from)}</td></> : <td colSpan={3} className="text-amber-800">Terms not set</td>}</tr>
            })}
          </tbody>
        </table>
        <TermsForm teamId={team.id} kinds={kinds} />
      </section>

      {sales.length > 0 && (
        <section className={card} aria-label="Sales">
          <h2 className="text-sm font-semibold text-slate-600">Sales</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Date</th><th className="pr-4">Lead</th><th className="pr-4">Kind</th><th className="pr-4">Amount</th><th className="pr-4">Seller</th><th className="pr-4">TD</th><th className="pr-4">Status</th><th>Actions</th></tr></thead>
              <tbody className="divide-y">
                {sales.map(s => (
                  <tr key={s.id} className="align-top">
                    <td className="py-2 pr-4 text-slate-500">{formatWhen(s.paid_at ?? s.created_at)}</td>
                    <td className="pr-4">{names.get(s.lead_id) ?? "Lead"}<span className="block text-xs text-slate-400">by {s.created_by}</span></td>
                    <td className="pr-4">{kindLabel(s.kind)}</td>
                    <td className="pr-4 font-medium">{formatMoney(s.amount_cents, s.currency)}</td>
                    <td className="pr-4">{s.status === "refunded" ? "—" : s.seller_cents === null ? <span className="text-amber-800">Terms not set</span> : formatMoney(s.seller_cents, s.currency)}</td>
                    <td className="pr-4">{s.status === "refunded" ? "—" : s.td_cents === null ? "—" : formatMoney(s.td_cents, s.currency)}</td>
                    <td className="pr-4">{saleStatusLabel(s)}{s.paid_out_at && <span className="block text-xs text-slate-400">{formatWhen(s.paid_out_at)} · {s.paid_out_reference}</span>}</td>
                    <td><SaleActions saleId={s.id} canApplyTerms={s.status === "paid" && s.seller_cents === null} canPayOut={canPayOut(s)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
