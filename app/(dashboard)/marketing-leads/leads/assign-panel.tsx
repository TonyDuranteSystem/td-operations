"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/** Gives a lead that has no team to a team. The server's answer, including a refusal, is shown as written (R099). */
export function AssignPanel({ leadId, teams }: { leadId: string; teams: Array<{ id: string; name: string }> }) {
  const router = useRouter()
  const [teamId, setTeamId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function assign() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing-admin/leads/${leadId}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || "Could not assign. Please try again.") }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not assign. Please try again.")
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-medium">This lead has no team, so nobody can see it yet.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select aria-label="Team" className="rounded-lg border bg-white px-3 py-2" value={teamId} onChange={e => setTeamId(e.target.value)}>
          <option value="">Pick a team…</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white disabled:opacity-50" disabled={busy || !teamId} onClick={assign}>{busy ? "Saving…" : "Give it to this team"}</button>
      </div>
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-rose-800">{error}</p>}
    </div>
  )
}
