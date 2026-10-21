"use client"

import { useState } from "react"

/** Antonio opens the team's workspace as the owner or as a role. Every screen works for him; what he does is recorded under his own email. */
export function ViewAsButtons({ teamId, options }: { teamId: string; options: Array<{ key: string; as: string; label: string }> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function go(as: string) {
    setBusy(as); setError(null)
    try {
      const res = await fetch("/api/marketing-admin/view-as", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId, as }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Could not open the view. Please try again.") }
      window.location.href = "/marketing"
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "Could not open the view. Please try again."); setBusy(null) }
  }
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-600">View as</h3>
      <p className="mt-1 text-xs text-slate-500">Open this team&apos;s workspace exactly as that person sees it. Nothing is blocked for you inside it, and what you do is recorded under your own email.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map(o => <button key={o.key} className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={busy !== null} onClick={() => go(o.as)}>{busy === o.as ? "Opening…" : o.label}</button>)}
      </div>
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </div>
  )
}
