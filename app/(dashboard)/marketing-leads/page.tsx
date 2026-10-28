import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { adminMemberContext } from "@/lib/marketing/guard"
import { loadOwnerHome } from "@/lib/marketing/home-server"
import { CallsPanel, MessagesPanel, WaitingPanel } from "@/components/marketing/owner-home-panels"
import { OwnerNeeds } from "@/components/marketing/owner-needs"
import { HomeNewsCard } from "@/components/marketing/home-news-card"
import { HomeDocuments } from "@/components/marketing/home-documents"
import { loadNewsAdmin } from "@/lib/marketing/news-server"
import { listGiveTargets } from "@/lib/marketing/give-lead"
import { makeT } from "@/lib/marketing/i18n"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { ageText } from "@/lib/marketing/master-view"
import { loadMasterData } from "@/lib/marketing/master-read"
import { listTeams } from "@/lib/marketing/settings"
import { listConnections } from "@/lib/marketing/meta-leads/key-store"
import { FillDetailsPanel } from "./fill-details-panel"

export const dynamic = "force-dynamic"

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
  // the button into the team's workspace only works once he has joined a team (the Teams page has the button that does it)
  const member = await adminMemberContext({ id: user.id, email: user.email })
  const joined = member.ok

  const db = leadDb()
  const teams = await listTeams()
  // no team picked: his own (the one he joined), else the first active one
  const team = teams.find(t => t.id === sp.team) ?? (member.ok ? teams.find(t => t.id === member.ctx.team.id) : undefined) ?? teams.find(t => t.status === "active") ?? teams[0] ?? null
  const [total, noDetails, connections, master, news, giveTargets] = await Promise.all([
    db.from("marketing_leads").select("id", { count: "exact", head: true }),
    db.from("marketing_leads").select("id", { count: "exact", head: true }).is("full_name", null).is("email", null).is("phone", null),
    listConnections(db, process.env.META_APP_SECRET),
    team ? loadMasterData(db, team.id) : Promise.resolve(null),
    loadNewsAdmin(),
    team ? listGiveTargets(team.id).catch(() => []) : Promise.resolve([]),
  ])
    const connection = [
    { label: "App secret", ok: !!process.env.META_APP_SECRET },
    { label: "Webhook verify token", ok: !!process.env.META_WEBHOOK_VERIFY_TOKEN },
    { label: "Page access key", ok: !!process.env.META_PAGE_ACCESS_TOKEN || connections.some(c => c.readable) },
    { label: "Page ids for the safety re-read", ok: !!process.env.META_PAGE_IDS },
  ]
  const connected = connection.every(c => c.ok)
  const lastCheckMs = master?.lastCheckAt ? Date.now() - new Date(master.lastCheckAt).getTime() : null
  // his own dashboard (messages for him, what waits on Rocco, today's calls) is read only when the team on this page is the one he has joined
  const tEn = makeT("en")
  const home = member.ok && team && member.ctx.team.id === team.id ? await loadOwnerHome(member.ctx, new Date(), "Unnamed lead") : null
  const teamQuery = team ? `?team=${team.id}` : ""
  const firstStage = master?.stages[0]?.key ?? "new"
  const maxFunnel = master ? Math.max(1, ...master.view.funnel.map(f => f.count)) : 1

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {master?.truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">Some of this month&apos;s activity is not counted below: there is too much to read at once.</p>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Marketing</h1>
          <p className="text-sm text-slate-500">
            {team ? <>Team: <b>{team.name}</b> ({team.status}){master ? ` · ${master.memberCount} ${master.memberCount === 1 ? "person" : "people"}` : ""}</> : "No team yet."}
          </p>
        </div>
        {team && (
          <div className="text-right">
            {joined
              ? <Link href="/marketing" data-testid="open-team-workspace" className="inline-block rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">Open the team workspace &#9656;</Link>
              : <Link href="/marketing-leads/teams" data-testid="join-team-workspace" className="inline-block rounded-lg border px-4 py-2 text-sm font-medium text-teal-800 hover:bg-slate-50">Join the team to open its workspace</Link>}
            <p className="mt-1 text-xs text-slate-500">Leads, board, calendar, chat</p>
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
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Numbers" data-testid="home-numbers">
            {[
              { label: "New in the last 24 h", v: master.view.newLast24h, bad: false, href: `/marketing-leads/leads${teamQuery}` },
              { label: "Nobody touched, over 24 h", v: master.view.untouchedOver24h, bad: master.view.untouchedOver24h > 0, href: `/marketing-leads/leads?${team ? `team=${team.id}&` : ""}stage=${firstStage}` },
              { label: "Call backs due today", v: master.view.callBacksDueToday, bad: false, href: "/marketing/calendar" },
              { label: "Sales paid this month", v: master.view.paidCallsThisMonth, bad: false, href: "/marketing-leads/money" },
            ].map(k => (
              <Link key={k.label} href={k.href} className="rounded-xl border bg-white p-4 hover:border-slate-400" data-testid="home-number">
                <div className="text-xs text-slate-500">{k.label}</div>
                <div className={`mt-1 font-mono text-2xl tabular-nums ${k.bad ? "text-red-600" : ""}`}>{k.v}</div>
              </Link>
            ))}
          </section>

          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <OwnerNeeds needs={master.view.needs} people={giveTargets} teams={teams.filter(t => t.status === "active").map(t => ({ id: t.id, name: t.name }))} currentTeamId={team?.id} />
            {home ? <MessagesPanel model={home.model} mode="crm" t={tEn} chatAny={home.chatAny} /> : (
              <section className="rounded-xl border bg-white p-5" aria-label="Messages for you" data-testid="home-join">
                <h2 className="text-sm font-semibold text-slate-600">Messages for you</h2>
                <p className="mt-2 text-sm text-slate-500">Join the team to see the messages for you, the calls today and what is waiting on Rocco here.</p>
                <Link href="/marketing-leads/teams" className="mt-3 inline-block rounded-lg border px-3 py-1.5 text-sm font-medium text-teal-800 hover:bg-slate-50">Join the team</Link>
              </section>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {home ? <div className="space-y-4"><CallsPanel model={home.model} mode="crm" t={tEn} locale="en-US" /><WaitingPanel model={home.model} mode="crm" t={tEn} /></div> : <div />}
            <HomeNewsCard news={news} />
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

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border bg-white p-5">
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
            <HomeDocuments />
          </div>

          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500" data-testid="home-health">
            <span><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />{connected ? "Meta connected" : "Meta not fully set up"}</span>
            <span><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${lastCheckMs !== null && lastCheckMs < 20 * 60_000 ? "bg-emerald-500" : "bg-red-500"}`} />{lastCheckMs === null ? "Lead check has not run" : `Last lead check ${ageText(lastCheckMs)} ago`}</span>
            <span><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${master.failedCount === 0 ? "bg-emerald-500" : "bg-red-500"}`} />{master.failedCount} failed</span>
          </p>
        </>
      )}

      <FillDetailsPanel missing={noDetails.count ?? 0} />

      <p className="text-sm"><Link className="font-medium text-teal-800 underline" href="/marketing-leads/leads">Open all {total.count ?? 0} leads →</Link> to see what each one answered, what the setter wrote, and the full history.</p>
      <p className="text-xs text-slate-400">Each team sees only its own leads at <Link className="underline" href="/marketing/leads">/marketing/leads</Link>.</p>
    </div>
  )
}
