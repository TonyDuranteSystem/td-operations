"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

async function post(url: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    if (res.ok) return null
    const d = await res.json().catch(() => ({}))
    return d.error || "Could not save. Please try again."
  } catch { return "Could not save. Please try again." }
}

/** Antonio sets the split for a kind of sale. It applies to links made from now on; past sales keep what they were sold under. */
export function TermsForm({ teamId, kinds }: { teamId: string; kinds: Array<{ key: string; label: string }> }) {
  const router = useRouter()
  const [kind, setKind] = useState("")
  const [pct, setPct] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = Number(pct)
  const valid = kind !== "" && pct.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100
  async function save() {
    setBusy(true); setError(null)
    const e = await post("/api/marketing-admin/terms", { teamId, kind, sellerPct: n })
    setBusy(false)
    if (e) setError(e); else { setKind(""); setPct(""); router.refresh() }
  }
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
      <label className="block"><span className="text-slate-500">Kind of sale</span>
        <select className="mt-1 block rounded-lg border px-3 py-2" value={kind} onChange={e => setKind(e.target.value)}><option value="">Pick…</option>{kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}</select></label>
      <label className="block"><span className="text-slate-500">Seller&apos;s share %</span>
        <input className="mt-1 block w-28 rounded-lg border px-3 py-2" inputMode="decimal" placeholder="80" value={pct} onChange={e => setPct(e.target.value)} /></label>
      <p className="pb-2 text-slate-500">{valid ? `TD keeps ${Math.round((100 - n) * 100) / 100}%` : ""}</p>
      <button className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white disabled:opacity-50" disabled={busy || !valid} onClick={save}>{busy ? "Saving…" : "Set the split"}</button>
      {error && <p role="alert" className="w-full rounded-lg bg-rose-50 px-3 py-2 text-rose-800">{error}</p>}
    </div>
  )
}

/** The two things Antonio can do to a sale: give a "terms not set" sale today's split, or mark the seller's share as paid out (date + bank reference). */
export function SaleActions({ saleId, canApplyTerms, canPayOut }: { saleId: string; canApplyTerms: boolean; canPayOut: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [ref, setRef] = useState("")
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(body: unknown) {
    setBusy(true); setError(null)
    const e = await post(`/api/marketing-admin/sales/${saleId}`, body)
    setBusy(false)
    if (e) setError(e); else { setOpen(false); router.refresh() }
  }
  const btn = "rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {canApplyTerms && <button className={btn} disabled={busy} onClick={() => run({ action: "apply_terms" })}>Apply today&apos;s split</button>}
        {canPayOut && <button className={btn} disabled={busy} onClick={() => setOpen(!open)}>Mark as paid</button>}
      </div>
      {open && (
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="block"><span className="text-slate-500">Date</span><input type="date" className="mt-1 block rounded border px-2 py-1" value={on} onChange={e => setOn(e.target.value)} /></label>
          <label className="block"><span className="text-slate-500">Bank reference</span><input className="mt-1 block rounded border px-2 py-1" value={ref} onChange={e => setRef(e.target.value)} /></label>
          <button className={`${btn} bg-slate-900 text-white`} disabled={busy || !ref.trim() || !on} onClick={() => run({ action: "mark_paid_out", reference: ref, paidOn: on })}>{busy ? "Saving…" : "Save"}</button>
        </div>
      )}
      {error && <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">{error}</p>}
    </div>
  )
}
