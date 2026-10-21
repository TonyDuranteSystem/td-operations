"use client"

import { useState } from "react"

interface Report { apply: boolean; withoutDetails: number; filled: number; names: number; emails: number; phones: number; testLeads: number; existingClients: number; failed: number }

/** Antonio's two steps for leads stored without a name, email or phone: count first, then fill in. Server errors are shown as the server wrote them (R099). */
export function FillDetailsPanel({ missing }: { missing: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Report | null>(null)
  const [done, setDone] = useState<Report | null>(null)

  async function run(apply: boolean) {
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/marketing-admin/leads/backfill-contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apply }) })
      const d = await res.json().catch(() => ({})) as { report?: Report; error?: string }
      if (!res.ok || !d.report) throw new Error(d.error || "It could not run. Please try again.")
      if (apply) { setDone(d.report); setPreview(null) } else { setPreview(d.report); setDone(null) }
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "It could not run. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (missing === 0 && !done) return null
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" aria-label="Leads without details">
      <h2 className="font-semibold">{missing} lead{missing === 1 ? " has" : "s have"} no name, email or phone saved</h2>
      <p className="mt-1 text-slate-700">The answers are all kept; the details can be filled in from them. Step 1 only counts. Nothing changes until step 2.</p>
      {!preview && !done && <button className="mt-3 rounded-lg border bg-white px-3 py-2 font-medium disabled:opacity-50" disabled={busy} onClick={() => run(false)}>{busy ? "Counting…" : "Step 1: count what can be filled in"}</button>}
      {preview && (
        <div className="mt-3 space-y-2">
          <p><b>{preview.filled}</b> of {preview.withoutDetails} leads can be filled in: {preview.names} names, {preview.emails} emails, {preview.phones} phone numbers.</p>
          <p>{preview.existingClients} look like existing TD clients (they will be flagged). {preview.testLeads} are Meta test leads (named &quot;Meta test lead&quot;).</p>
          <div className="flex gap-2">
            <button className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white disabled:opacity-50" disabled={busy || preview.filled === 0} onClick={() => run(true)}>{busy ? "Filling in…" : `Step 2: fill in ${preview.filled} leads`}</button>
            <button className="rounded-lg border bg-white px-3 py-2 font-medium" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
      {done && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900" role="status">Done: {done.filled - done.failed} leads filled in{done.failed ? `, ${done.failed} could not be saved (run it again)` : ""}; {done.existingClients} flagged as possible existing clients. Reload the page to see them.</p>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-rose-800">{error}</p>}
    </section>
  )
}
