import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { getLeadAny, leadHistory, listLeadsFiltered } from "@/lib/marketing/admin-leads"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { clientFlagText, eventText, formatWhen, prettyAnswer, prettyQuestion, stageLabel, telHref, type StageOption } from "@/lib/marketing/lead-view"
import { listTeams, getMarketingSetting } from "@/lib/marketing/settings"
import { AssignPanel } from "./assign-panel"

export const dynamic = "force-dynamic"

type SP = { team?: string; stage?: string; q?: string; lead?: string }
const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? "border-slate-900 bg-slate-900 text-white" : "bg-white text-slate-600"}`

/**
 * TD Marketing — every lead of every team (dev job 9aec66fa): a list on the left (filter by team, stage, text) and, for the lead you click, everything on the right:
 * contact details, what they answered on the form, what the setter decided and wrote, who picked it, and the whole history. Admin only (strict check).
 */
export default async function AllLeadsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const sp = await searchParams
  const db = leadDb()
  const teams = await listTeams()
  const activeTeam = teams.find(t => t.id === sp.team)?.id ?? (sp.team === "none" ? "none" : null)
  const [stages, reasons, leads, selected] = await Promise.all([
    getMarketingSetting("pipeline_stages", activeTeam && activeTeam !== "none" ? activeTeam : teams.find(t => t.status === "active")?.id) as Promise<StageOption[]>,
    getMarketingSetting("not_in_target_reasons") as Promise<StageOption[]>,
    listLeadsFiltered(db, { team: activeTeam, stage: sp.stage || null, q: sp.q ?? null }),
    sp.lead ? getLeadAny(db, sp.lead) : Promise.resolve(null),
  ])
  const events = selected ? await leadHistory(db, selected.id) : []
  const teamName = new Map(teams.map(t => [t.id, t.name]))
  const href = (n: Partial<SP>) => {
    const q = new URLSearchParams()
    const m = { team: sp.team, stage: sp.stage, q: sp.q, lead: sp.lead, ...n }
    for (const [k, v] of Object.entries(m)) if (v) q.set(k, v)
    const t = q.toString()
    return t ? `/marketing-leads/leads?${t}` : "/marketing-leads/leads"
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">All leads</h1><p className="text-sm text-slate-500">Every lead of every team. Click one to see everything about it.</p></div>
        <form action="/marketing-leads/leads" className="flex gap-2">
          {sp.team && <input type="hidden" name="team" value={sp.team} />}
          {sp.stage && <input type="hidden" name="stage" value={sp.stage} />}
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search name, email, phone, ad…" aria-label="Search" className="w-64 rounded-lg border px-3 py-2 text-sm" />
          <button className="rounded-lg border bg-white px-3 py-2 text-sm font-medium">Search</button>
        </form>
      </div>

      <nav aria-label="Filters" className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Link href={href({ team: "", lead: "" })} className={chip(!sp.team)}>All teams</Link>
          {teams.map(t => <Link key={t.id} href={href({ team: t.id, lead: "" })} className={chip(sp.team === t.id)}>{t.name}</Link>)}
          <Link href={href({ team: "none", lead: "" })} className={chip(sp.team === "none")}>No team yet</Link>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={href({ stage: "", lead: "" })} className={chip(!sp.stage)}>Every stage</Link>
          {stages.map(s => <Link key={s.key} href={href({ stage: s.key, lead: "" })} className={chip(sp.stage === s.key)}>{s.label}</Link>)}
        </div>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="min-w-0 overflow-x-auto rounded-xl border bg-white">
          {leads.length === 0 ? <p className="p-5 text-sm text-slate-600">No leads match.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">Lead</th><th className="px-3 py-2">Where it stands</th></tr></thead>
              <tbody className="divide-y">
                {leads.map(l => (
                  <tr key={l.id} className={l.id === sp.lead ? "bg-teal-50" : "hover:bg-slate-50"}>
                    <td className="px-3 py-2"><Link href={href({ lead: l.id })} className="block font-medium">{l.full_name || l.email || l.phone || "Unnamed lead"}</Link><span className="block text-xs text-slate-500">{[l.phone, l.email].filter(Boolean).join(" · ") || "No contact details"}</span><span className="block text-xs text-slate-400">{formatWhen(l.meta_created_time ?? l.received_at)}</span></td>
                    <td className="px-3 py-2"><span className="font-medium">{stageLabel(stages, l.status)}</span>{l.callback_at && <span className="block text-xs text-sky-700">Call back {formatWhen(l.callback_at)}</span>}{clientFlagText(l.existing_client) && <span className="block text-xs text-amber-800">Existing client?</span>}<span className="block text-xs text-slate-500">{l.claimed_by_label ? `Picked by ${l.claimed_by_label}` : "Not picked"}</span><span className="block text-xs text-slate-500">{l.team_id ? teamName.get(l.team_id) ?? "Unknown team" : <span className="text-amber-700">No team yet</span>}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <aside className="min-w-0 space-y-3" aria-label="Lead detail">
          {!selected ? <div className="rounded-xl border border-dashed p-6 text-sm text-slate-500">Click a lead on the left to see what they answered, what the setter wrote, and everything that happened to it.</div> : (
            <>
              <div className="rounded-xl border bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-semibold">{selected.full_name || selected.email || selected.phone || "Unnamed lead"}</h2>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs">{stageLabel(stages, selected.status)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-500">Filled in {formatWhen(selected.meta_created_time ?? selected.received_at)} · {[selected.campaign_name, selected.adset_name, selected.ad_name].filter(Boolean).join(" › ") || "Meta lead form"}</p>
                <div className="mt-3 space-y-1 text-sm">
                  {selected.phone && <p><span className="text-slate-500">Phone: </span>{telHref(selected.phone) ? <a className="underline" href={telHref(selected.phone) as string}>{selected.phone}</a> : selected.phone}</p>}
                  {selected.email && <p><span className="text-slate-500">Email: </span><a className="underline" href={`mailto:${selected.email}`}>{selected.email}</a></p>}
                  {(selected.city || selected.country) && <p><span className="text-slate-500">Place: </span>{[selected.city, selected.country].filter(Boolean).join(", ")}</p>}
                  <p><span className="text-slate-500">Team: </span>{selected.team_id ? teamName.get(selected.team_id) ?? "Unknown team" : "none yet"}</p>
                  <p><span className="text-slate-500">Picked by: </span>{selected.claimed_by_label ?? "nobody"}{selected.claimed_at && ` (${formatWhen(selected.claimed_at)})`}</p>
                  {selected.callback_at && <p><span className="text-slate-500">Call back: </span><b>{formatWhen(selected.callback_at)}</b></p>}
                  {selected.not_in_target_reason && <p><span className="text-slate-500">Not in target because: </span>{reasons.find(r => r.key === selected.not_in_target_reason)?.label ?? selected.not_in_target_reason}</p>}
                </div>
                {clientFlagText(selected.existing_client) && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">{clientFlagText(selected.existing_client)}</p>}
              </div>

              {!selected.team_id && <AssignPanel leadId={selected.id} teams={teams.map(t => ({ id: t.id, name: t.name }))} />}

              {selected.qualification && selected.qualification.length > 0 && (
                <div className="rounded-xl border bg-white p-4 text-sm"><h3 className="text-sm font-semibold text-slate-600">What the setter confirmed on the call</h3>
                  <ul className="mt-2 space-y-1">{selected.qualification.map(q => <li key={q.item}>{q.ticked ? "✔" : "✘"} {q.item}</li>)}</ul></div>
              )}

              <div className="rounded-xl border bg-white p-4 text-sm"><h3 className="text-sm font-semibold text-slate-600">What they answered on the form</h3>
                {selected.answers.length === 0 ? <p className="mt-2 text-slate-500">No answers were received.</p> : (
                  <dl className="mt-2 divide-y">{selected.answers.map((a, i) => (
                    <div key={`${a.name}-${i}`} className="grid gap-1 py-2 sm:grid-cols-3"><dt className="text-slate-500">{prettyQuestion(a.name.replace(/\?$/, ""))}</dt><dd className="sm:col-span-2">{a.values.length ? a.values.map(prettyAnswer).join(", ") : "—"}</dd></div>
                  ))}</dl>
                )}
              </div>

              <div className="rounded-xl border bg-white p-4 text-sm"><h3 className="text-sm font-semibold text-slate-600">History</h3>
                <ol className="mt-2 space-y-1.5">
                  {events.map(e => (
                    <li key={e.id} className="flex justify-between gap-3 rounded-lg border px-3 py-2">
                      <span>{eventText(e.kind, e.data, stages, reasons)}{e.actor !== "system" && <span className="text-slate-400"> · {e.actor}</span>}</span>
                      <span className="shrink-0 text-xs text-slate-400">{formatWhen(e.created_at)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
