import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { listAllLeads } from "@/lib/marketing/leads-read"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { clientFlagText, formatWhen, stageLabel } from "@/lib/marketing/lead-view"
import { ageText } from "@/lib/marketing/master-view"
import { loadMasterData } from "@/lib/marketing/master-read"
import { listTeams } from "@/lib/marketing/settings"
import { listConnections } from "@/lib/marketing/meta-leads/key-store"
import { MetaConnectionPanel } from "./meta-connection-panel"

export const dynamic = "force-dynamic"

const TONE = { bad: "bg-red-50 text-red-700", warn: "bg-amber-50 text-amber-800" } as const

/**
 * TD Marketing — Antonio's master view (dev job 9aec66fa): are leads arriving, is anyone sitting on them, what needs him today, what each person did,
 * then every lead of every team and the health of the Meta connection. Admin only (the strict admin check, which does not trust self-writable profile
 * fields). Marketing logins never reach the CRM. Every number is defined in lib/marketing/master-view.ts.
 */
export default async function MarketingLeadsAdminPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const sp = await searchParams

  const db = leadDb()
  const teams = await listTeams()
  const team = teams.find(t => t.id === sp.team) ?? teams.find(t => t.status === "active") ?? teams[0] ?? null
  const [leads, evts, connections, master] = await Promise.all([
    listAllLeads(db),
    db.from("marketing_leadgen_events").select("status, last_error, updated_at").in("status", ["pending", "failed", "gave_up"]).order("updated_at", { ascending: false }).limit(50),
    listConnections(db, process.env.META_APP_SECRET),
    team ? loadMasterData(db, team.id) : Promise.resolve(null),
  ])
  const teamName = new Map(teams.map(t => [t.id, t.name]))
  const open = (evts.data ?? []) as Array<{ status: string; last_error: string | null; updated_at: string }>
  const count = (s: string) => open.filter(e => e.status === s).length
  const unassigned = leads.filter(l => !l.team_id).length
  const stages = master?.stages ?? []
  const connection = [
    { label: "App secret", ok: !!process.env.META_APP_SECRET },
    { label: "Webhook verify token", ok: !!process.env.META_WEBHOOK_VERIFY_TOKEN },
    { label: "Page access key", ok: !!process.env.META_PAGE_ACCESS_TOKEN || connections.some(c => c.readable) },
    { label: "Page ids for the safety re-read", ok: !!process.env.META_PAGE_IDS },
  ]
  const connected = connection.every(c => c.ok)
  const lastCheckMs = master?.lastCheckAt ? Date.now() - new Date(master.lastCheckAt).getTime() : null
  const maxFunnel = master ? Math.max(1, ...master.view.funnel.map(f => f.count)) : 1

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Marketing</h1>
          <p className="text-sm text-slate-500">
            {team ? <>Team: <b>{team.name}</b> ({team.status}){master ? ` · ${master.memberCount} ${master.memberCount === 1 ? "person" : "people"}` : ""}</> : "No team yet."}
          </p>
        </div>
        {master && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span><span className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />{connected ? "Meta connected" : "Meta not fully set up"}</span>
            <span><span className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full ${lastCheckMs !== null && lastCheckMs < 20 * 60_000 ? "bg-emerald-500" : "bg-red-500"}`} />{lastCheckMs === null ? "Lead check has not run" : `Last lead check ${ageText(lastCheckMs)} ago`}</span>
            <span><span className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full ${master.failedCount === 0 ? "bg-emerald-500" : "bg-red-500"}`} />{master.failedCount} failed</span>
          </div>
        )}
      </div>

      {teams.length > 1 && (
        <nav aria-label="Teams" className="flex flex-wrap gap-2">
          {teams.map(t => (
            <Link key={t.id} href={`/marketing-leads?team=${t.id}`} className={`rounded-full border px-3 py-1 text-xs ${t.id === team?.id ? "border-slate-900 bg-slate-900 text-white" : "bg-white text-slate-600"}`}>{t.name}</Link>
          ))}
        </nav>
      )}

      {master && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Numbers">
            {[
              { label: "New in the last 24 h", v: master.view.newLast24h, bad: false },
              { label: "Nobody touched, over 24 h", v: master.view.untouchedOver24h, bad: master.view.untouchedOver24h > 0 },
              { label: "Call backs due today", v: master.view.callBacksDueToday, bad: false },
              { label: "Paid calls this month", v: master.view.paidCallsThisMonth, bad: false },
            ].map(k => (
              <div key={k.label} className="rounded-xl border bg-white p-4">
                <div className="text-xs text-slate-500">{k.label}</div>
                <div className={`mt-1 font-mono text-2xl tabular-nums ${k.bad ? "text-red-600" : ""}`}>{k.v}</div>
              </div>
            ))}
          </section>

          <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
            <section className="rounded-xl border bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-600">Where the leads are</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {master.view.funnel.map(f => (
                  <li key={f.key} className="grid grid-cols-[7rem_1fr_2rem] items-center gap-3">
                    <span>{f.label}</span>
                    <span className="h-3 rounded bg-slate-100"><span className="block h-3 rounded bg-teal-700" style={{ width: `${Math.round((f.count / maxFunnel) * 100)}%` }} /></span>
                    <span className="text-right font-mono tabular-nums">{f.count}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-xl border bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-600">Needs you</h2>
              {master.view.needs.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">Nothing needs you right now.</p>
              ) : (
                <ul className="mt-3 divide-y text-sm">
                  {master.view.needs.map((n, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <span>{n.text}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${TONE[n.tone]}`}>{n.key === "unassigned" ? "Assign" : n.key === "existing_client" ? "Check" : n.key === "late_callbacks" ? "Late" : "Slow"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="rounded-xl border bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-600">What each person did today</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs text-slate-500">
                  <tr><th className="py-2 pr-3">Person</th><th className="pr-3">Role</th><th className="pr-3 text-right">Good</th><th className="pr-3 text-right">Not in target</th><th className="pr-3 text-right">Call backs set</th><th className="pr-3 text-right">Leads picked</th><th>Last active</th></tr>
                </thead>
                <tbody className="divide-y">
                  {master.view.people.length === 0 && <tr><td colSpan={7} className="py-3 text-slate-500">Nobody has joined this team yet.</td></tr>}
                  {master.view.people.map(p => (
                    <tr key={p.email}>
                      <td className="py-2 pr-3 font-medium">{p.email}</td>
                      <td className="pr-3 capitalize">{p.role}</td>
                      <td className="pr-3 text-right font-mono tabular-nums">{p.good}</td>
                      <td className="pr-3 text-right font-mono tabular-nums">{p.notInTarget}</td>
                      <td className="pr-3 text-right font-mono tabular-nums">{p.callBacks}</td>
                      <td className="pr-3 text-right font-mono tabular-nums">{p.picked}</td>
                      <td className="text-slate-500">{p.lastActive ? `${ageText(Date.now() - new Date(p.lastActive).getTime())} ago` : "never"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Meta connection</h2>
        <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
          {connection.map(c => (
            <li key={c.label} className="flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${c.ok ? "bg-emerald-500" : "bg-red-500"}`} />
              {c.label}: {c.ok ? "set" : "not set"}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          Waiting to be fetched: <b>{count("pending")}</b> · Failed, will retry: <b>{count("failed")}</b> · Gave up: <b className={count("gave_up") ? "text-red-600" : ""}>{count("gave_up")}</b>
          {unassigned > 0 && <> · <b className="text-amber-700">{unassigned} lead{unassigned === 1 ? "" : "s"} with no team yet</b></>}
        </p>
        {open.find(e => e.last_error) && <p className="mt-1 text-xs text-slate-500">Latest problem: {open.find(e => e.last_error)?.last_error}</p>}
        <MetaConnectionPanel />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600">All leads, every team ({leads.length} shown)</h2>
        {leads.length === 0 ? (
          <p className="rounded-xl border bg-white p-5 text-sm text-slate-600">No leads yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-50 text-xs text-slate-500">
                <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Contact</th><th className="px-3 py-2">Campaign</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">Picked by</th><th className="px-3 py-2">Team</th><th className="px-3 py-2">Note</th></tr>
              </thead>
              <tbody className="divide-y">
                {leads.map(l => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">{formatWhen(l.meta_created_time ?? l.received_at)}</td>
                    <td className="px-3 py-2 font-medium">{l.full_name || "—"}</td>
                    <td className="px-3 py-2">{[l.phone, l.email].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-slate-500">{l.campaign_name || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{stageLabel(stages, l.status)}{l.callback_at && <span className="block text-xs text-sky-700">Call back {formatWhen(l.callback_at)}</span>}</td>
                    <td className="px-3 py-2 text-slate-500">{l.claimed_by_label ?? "—"}</td>
                    <td className="px-3 py-2">{l.team_id ? teamName.get(l.team_id) ?? "Unknown team" : <span className="text-amber-700">Not assigned</span>}</td>
                    <td className="px-3 py-2 text-xs text-amber-900">{clientFlagText(l.existing_client) ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-xs text-slate-400">Each team sees only its own leads at <Link className="underline" href="/marketing/leads">/marketing/leads</Link>.</p>
    </div>
  )
}
