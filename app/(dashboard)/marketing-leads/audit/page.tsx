import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { eventText, formatWhen, type StageOption } from "@/lib/marketing/lead-view"
import { getMarketingSetting } from "@/lib/marketing/settings"

export const dynamic = "force-dynamic"

const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? "border-slate-900 bg-slate-900 text-white" : "bg-white text-slate-600"}`

/** TD Marketing — what everyone did (dev job 9aec66fa): every action on every lead, newest first, who and when. Filter by person. Admin only (strict check). */
export default async function MarketingAuditPage({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const sp = await searchParams
  const db = leadDb()
  const { data } = await db.from("marketing_lead_events").select("id, lead_id, kind, actor, data, created_at").neq("kind", "received").order("created_at", { ascending: false }).limit(600)
  const all = (data ?? []) as Array<{ id: number; lead_id: string; kind: string; actor: string; data: Record<string, unknown>; created_at: string }>
  const people = Array.from(new Set(all.map(e => e.actor))).sort()
  const shown = (sp.who ? all.filter(e => e.actor === sp.who) : all).slice(0, 300)
  const ids = Array.from(new Set(shown.map(e => e.lead_id)))
  const { data: ls } = ids.length ? await db.from("marketing_leads").select("id, full_name, email, phone").in("id", ids) : { data: [] }
  const name = new Map(((ls ?? []) as Array<{ id: string; full_name: string | null; email: string | null; phone: string | null }>).map(l => [l.id, l.full_name || l.email || l.phone || "Unnamed lead"]))
  const [stages, reasons] = await Promise.all([getMarketingSetting("pipeline_stages") as Promise<StageOption[]>, getMarketingSetting("not_in_target_reasons") as Promise<StageOption[]>])

  return (
    <div className="space-y-4 p-6">
      <div><h1 className="text-2xl font-semibold">Audit log</h1><p className="text-sm text-slate-500">What was done on the leads, newest first. {shown.length} shown.</p></div>
      <nav aria-label="People" className="flex flex-wrap gap-2">
        <Link href="/marketing-leads/audit" className={chip(!sp.who)}>Everyone</Link>
        {people.map(p => <Link key={p} href={`/marketing-leads/audit?who=${encodeURIComponent(p)}`} className={chip(sp.who === p)}>{p === "system" ? "System" : p}</Link>)}
      </nav>
      {shown.length === 0 ? <p className="rounded-xl border bg-white p-5 text-sm text-slate-600">Nothing has happened yet. Every pick, Good, Not in target, call back, note and assignment will appear here.</p> : (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">Lead</th><th className="px-3 py-2">What</th></tr></thead>
            <tbody className="divide-y">
              {shown.map(e => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{formatWhen(e.created_at)}</td>
                  <td className="px-3 py-2">{e.actor === "system" ? <span className="text-slate-400">System</span> : e.actor}</td>
                  <td className="px-3 py-2"><Link className="underline" href={`/marketing-leads/leads?lead=${e.lead_id}`}>{name.get(e.lead_id) ?? "Lead"}</Link></td>
                  <td className="px-3 py-2">{eventText(e.kind, e.data, stages, reasons)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
