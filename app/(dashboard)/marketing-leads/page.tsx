import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { listAllLeads } from "@/lib/marketing/leads-read"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { clientFlagText, formatWhen } from "@/lib/marketing/lead-view"
import { listTeams } from "@/lib/marketing/settings"
import { MetaConnectionPanel } from "./meta-connection-panel"

export const dynamic = "force-dynamic"

/**
 * TD Marketing — Antonio's master view of every lead from the ads (dev job 9aec66fa, Slice 1) and the health of the Meta connection.
 * Admin only (the strict admin check, which does not trust self-writable profile fields). Marketing logins never reach the CRM.
 */
export default async function MarketingLeadsAdminPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")

  const db = leadDb()
  const [leads, teams, evts] = await Promise.all([
    listAllLeads(db),
    listTeams(),
    db.from("marketing_leadgen_events").select("status, last_error, updated_at").in("status", ["pending", "failed", "gave_up"]).order("updated_at", { ascending: false }).limit(50),
  ])
  const teamName = new Map(teams.map(t => [t.id, t.name]))
  const open = (evts.data ?? []) as Array<{ status: string; last_error: string | null; updated_at: string }>
  const count = (s: string) => open.filter(e => e.status === s).length
  const unassigned = leads.filter(l => !l.team_id).length
  const connection = [
    { label: "App secret", ok: !!process.env.META_APP_SECRET },
    { label: "Webhook verify token", ok: !!process.env.META_WEBHOOK_VERIFY_TOKEN },
    { label: "Page access token", ok: !!process.env.META_PAGE_ACCESS_TOKEN },
    { label: "Page ids for the safety re-read", ok: !!process.env.META_PAGE_IDS },
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Marketing leads</h1>
        <p className="text-sm text-slate-500">Every lead that arrived from the ads, across all teams. {leads.length} shown.</p>
      </div>

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
        {leads.length === 0 ? (
          <p className="rounded-xl border bg-white p-5 text-sm text-slate-600">No leads yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-50 text-xs text-slate-500">
                <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Contact</th><th className="px-3 py-2">Campaign</th><th className="px-3 py-2">Team</th><th className="px-3 py-2">Note</th></tr>
              </thead>
              <tbody className="divide-y">
                {leads.map(l => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">{formatWhen(l.meta_created_time ?? l.received_at)}</td>
                    <td className="px-3 py-2 font-medium">{l.full_name || "—"}</td>
                    <td className="px-3 py-2">{[l.phone, l.email].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-slate-500">{l.campaign_name || "—"}</td>
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
