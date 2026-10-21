import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { listTeams } from "@/lib/marketing/settings"
import { listMembers, listOpenInvites } from "@/lib/marketing/members"
import { ageText, romeStartOfMonth } from "@/lib/marketing/master-view"
import { formatWhen } from "@/lib/marketing/lead-view"
import { roleLabel } from "@/lib/marketing/permission-labels"
import { TeamControls } from "./team-controls"

export const dynamic = "force-dynamic"

const PILL = { active: "bg-emerald-50 text-emerald-800", paused: "bg-amber-50 text-amber-800", draft: "bg-slate-100 text-slate-700" } as const

/** TD Marketing — the teams (dev job 9aec66fa): who is on each, whether it is switched on, how each setter is doing this month, the kill switch and the owner invitation. Admin only (strict check). */
export default async function MarketingTeamsPage() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const db = leadDb()
  const teams = await listTeams()
  const monthStart = romeStartOfMonth(new Date()).toISOString()
  const { data: evData } = await db.from("marketing_lead_events").select("lead_id, kind, actor, data, created_at").gte("created_at", monthStart).limit(20000)
  const events = (evData ?? []) as Array<{ lead_id: string; kind: string; actor: string; data: Record<string, unknown>; created_at: string }>
  const blocks = await Promise.all(teams.map(async t => {
    const [members, invites, leadIds] = await Promise.all([
      listMembers(t.id), listOpenInvites(t.id),
      db.from("marketing_leads").select("id").eq("team_id", t.id).limit(5000),
    ])
    return { t, members: members.filter(m => m.status !== "removed"), invites, ids: new Set(((leadIds.data ?? []) as Array<{ id: string }>).map(x => x.id)) }
  }))

  return (
    <div className="space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">Teams</h1><p className="text-sm text-slate-500">Who is on each team, and the switch that turns a team on or off.</p></div>
      {teams.length === 0 && <p className="rounded-xl border bg-white p-5 text-sm text-slate-600">There is no team yet.</p>}
      {blocks.map(({ t, members, invites, ids }) => {
        const mine = events.filter(e => ids.has(e.lead_id))
        const rows = members.filter(m => m.member_role !== "owner").map(m => {
          const ev = mine.filter(e => e.actor === m.email)
          const out = (o: string) => ev.filter(e => e.kind === "status_changed" && e.data?.outcome === o).length
          const good = out("good"), nit = out("not_in_target"), cb = out("call_back")
          return { m, good, nit, cb, rate: good + nit > 0 ? Math.round((good / (good + nit)) * 100) : null }
        })
        return (
          <section key={t.id} className="space-y-4 rounded-xl border bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">{t.name}</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${PILL[t.status]}`}>{t.status === "active" ? "On" : t.status === "paused" ? "Paused: nobody can work" : "Not switched on yet"}</span>
            </div>
            <TeamControls teamId={t.id} status={t.status} hasOwner={members.some(m => m.member_role === "owner")} />

            <div>
              <h3 className="text-sm font-semibold text-slate-600">People ({members.length})</h3>
              {members.length === 0 ? <p className="mt-1 text-sm text-slate-500">Nobody has joined yet.</p> : (
                <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">Person</th><th className="pr-3">Role</th><th className="pr-3">Status</th><th>Last seen</th></tr></thead>
                  <tbody className="divide-y">{members.map(m => (
                    <tr key={m.user_id}><td className="py-2 pr-3 font-medium">{m.email ?? "Unknown login"}</td><td className="pr-3">{m.member_role === "owner" ? "Team owner" : roleLabel(m.bundle)}</td><td className="pr-3">{m.status === "paused" ? "Paused" : "Active"}</td><td className="text-slate-500">{m.last_sign_in_at ? `${ageText(Date.now() - new Date(m.last_sign_in_at).getTime())} ago` : "has not signed in yet"}</td></tr>
                  ))}</tbody></table></div>
              )}
              {invites.length > 0 && <p className="mt-2 text-sm text-slate-600">Invitations waiting: {invites.map(i => `${i.email_lower} (expires ${formatWhen(i.expires_at)})`).join(", ")}</p>}
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-600">Setters this month</h3>
              {rows.length === 0 ? <p className="mt-1 text-sm text-slate-500">No setters yet.</p> : (
                <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">Setter</th><th className="pr-3 text-right">Marked Good</th><th className="pr-3 text-right">Not in target</th><th className="pr-3 text-right">Call backs set</th><th className="text-right">Good rate</th></tr></thead>
                  <tbody className="divide-y">{rows.map(r => (
                    <tr key={r.m.user_id}><td className="py-2 pr-3 font-medium">{r.m.email}</td><td className="pr-3 text-right font-mono tabular-nums">{r.good}</td><td className="pr-3 text-right font-mono tabular-nums">{r.nit}</td><td className="pr-3 text-right font-mono tabular-nums">{r.cb}</td><td className="text-right font-mono tabular-nums">{r.rate === null ? "—" : `${r.rate}%`}</td></tr>
                  ))}</tbody></table></div>
              )}
              <p className="mt-1 text-xs text-slate-400">Good rate = Good out of every lead the setter marked Good or Not in target. Calls themselves are not recorded yet.</p>
            </div>
          </section>
        )
      })}
    </div>
  )
}
