import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { listConnections } from "@/lib/marketing/meta-leads/key-store"
import { getAllMarketingSettings, listCommissionTerms, listTeams } from "@/lib/marketing/settings"
import { formatWhen, type StageOption } from "@/lib/marketing/lead-view"
import type { Option } from "@/lib/marketing/settings-edit"
import { MetaConnectionPanel } from "../meta-connection-panel"
import { SettingsEditor } from "./settings-editor"

export const dynamic = "force-dynamic"

/** TD Marketing — Antonio's settings (dev job 9aec66fa): the Meta connection, the Good checklist, the reasons, the switches, the currencies, and the commission terms in force. Admin only (strict check). */
export default async function MarketingSettingsPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const sp = await searchParams
  const teams = await listTeams()
  const team = teams.find(t => t.id === sp.team) ?? teams.find(t => t.status === "active") ?? teams[0] ?? null
  const db = leadDb()
  const connections = await listConnections(db, process.env.META_APP_SECRET)
  const connection = [
    { label: "App secret", ok: !!process.env.META_APP_SECRET },
    { label: "Webhook verify token", ok: !!process.env.META_WEBHOOK_VERIFY_TOKEN },
    { label: "Page access key", ok: !!process.env.META_PAGE_ACCESS_TOKEN || connections.some(c => c.readable) },
    { label: "Page ids for the safety re-read", ok: !!process.env.META_PAGE_IDS },
  ]
  const s = team ? await getAllMarketingSettings(team.id) : null
  const terms = team ? await listCommissionTerms(team.id) : []

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">Settings</h1><p className="text-sm text-slate-500">{team ? <>For the team <b>{team.name}</b>. Every rule is a setting here, never fixed in the code.</> : "Create a team first."}</p></div>

      {teams.length > 1 && (
        <nav aria-label="Teams" className="flex flex-wrap gap-2">
          {teams.map(t => <Link key={t.id} href={`/marketing-leads/settings?team=${t.id}`} className={`rounded-full border px-3 py-1 text-xs ${t.id === team?.id ? "border-slate-900 bg-slate-900 text-white" : "bg-white text-slate-600"}`}>{t.name}</Link>)}
        </nav>
      )}

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Meta connection</h2>
        <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
          {connection.map(c => (
            <li key={c.label} className="flex items-center gap-2"><span className={`inline-block h-2.5 w-2.5 rounded-full ${c.ok ? "bg-emerald-500" : "bg-red-500"}`} />{c.label}: {c.ok ? "set" : "not set"}</li>
          ))}
        </ul>
        <MetaConnectionPanel />
      </section>

      {team && s && (
        <>
          <SettingsEditor
            teamId={team.id}
            checklist={s.qualification_checklist as string[]}
            reasons={s.not_in_target_reasons as Option[]}
            switches={{ owner_may_create_offers: !!s.owner_may_create_offers, owner_may_export_leads: !!s.owner_may_export_leads, member_invites_need_approval: !!s.member_invites_need_approval }}
            currencies={s.allowed_currencies as string[]}
          />
          <section className="rounded-xl border bg-white p-4 text-sm">
            <h2 className="text-sm font-semibold text-slate-600">Pipeline stages (in order)</h2>
            <p className="mt-2">{(s.pipeline_stages as StageOption[]).map(x => x.label).join(" → ")}</p>
            <p className="mt-1 text-xs text-slate-500">Changed with care, because every lead sits in one of these. Ask me to change them.</p>
          </section>
          <section className="rounded-xl border bg-white p-4 text-sm">
            <h2 className="text-sm font-semibold text-slate-600">Commission terms in force</h2>
            {terms.length === 0 ? <p className="mt-2 text-slate-500">None set. Nothing is worked out until you set the split.</p> : (
              <table className="mt-2 w-full text-left"><thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">Applies to</th><th className="pr-3 text-right">Seller</th><th className="pr-3 text-right">TD</th><th>From</th></tr></thead>
                <tbody className="divide-y">{terms.map(t => <tr key={t.id}><td className="py-2 pr-3">{t.kind} · {t.person_ref}</td><td className="pr-3 text-right font-mono tabular-nums">{t.seller_pct}%</td><td className="pr-3 text-right font-mono tabular-nums">{t.td_pct}%</td><td>{formatWhen(t.effective_from)}</td></tr>)}</tbody></table>
            )}
            <p className="mt-2 text-xs text-slate-500">The form to change the split comes with the payment screens.</p>
          </section>
        </>
      )}
    </div>
  )
}
