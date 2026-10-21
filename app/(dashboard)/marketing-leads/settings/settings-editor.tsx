"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { buildOptions, cleanChecklist, type Option, type OptionRow } from "@/lib/marketing/settings-edit"

interface Props {
  teamId: string
  checklist: string[]
  reasons: Option[]
  switches: { owner_may_create_offers: boolean; owner_may_export_leads: boolean; member_invites_need_approval: boolean }
  currencies: string[]
}

const SWITCH_LABELS: Array<[keyof Props["switches"], string, string]> = [
  ["owner_may_create_offers", "Rocco may create offers", "Off: he sells the strategic call and you send the offer after the upsell call."],
  ["owner_may_export_leads", "Rocco may export lead lists", "Every export is logged."],
  ["member_invites_need_approval", "New people need my approval", "Off: Rocco adds his people himself."],
]

/** Antonio's editable settings: the Good checklist, the "not in target" reasons, the switches and the currencies. Each block saves on its own; the server's answer is shown as written (R099). */
export function SettingsEditor(p: Props) {
  const router = useRouter()
  const [checklist, setChecklist] = useState(p.checklist.length ? p.checklist : [""])
  const [reasons, setReasons] = useState<OptionRow[]>(p.reasons.map(r => ({ key: r.key, label: r.label })))
  const [currencies, setCurrencies] = useState(p.currencies.join(", "))
  const [sw, setSw] = useState(p.switches)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function save(key: string, value: unknown, message: string) {
    setBusy(key); setError(null); setDone(null)
    try {
      const res = await fetch("/api/marketing-admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId: p.teamId, key, value }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || "Could not save. Please try again.") }
      setDone(message); router.refresh()
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "Could not save. Please try again.") } finally { setBusy(null) }
  }

  const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50"
  const row = (label: string, i: number, value: string, placeholder: string, onText: (v: string) => void, onRemove: () => void) => (
    <div key={i} className="flex gap-2">
      <input aria-label={`${label} ${i + 1}`} className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" value={value} placeholder={placeholder} maxLength={80} onChange={e => onText(e.target.value)} />
      <button className={btn} aria-label={`Remove ${label} ${i + 1}`} onClick={onRemove}>Remove</button>
    </div>
  )
  const checklistList = (
    <div className="space-y-2">
      {checklist.map((it, i) => row("Checklist line", i, it, "For example: Has or plans a business", v => setChecklist(checklist.map((x, j) => (j === i ? v : x))), () => setChecklist(checklist.filter((_, j) => j !== i))))}
      <button className={btn} onClick={() => setChecklist([...checklist, ""])}>Add a line</button>
    </div>
  )
  const reasonsList = (
    <div className="space-y-2">
      {reasons.map((r, i) => row("Reason", i, r.label, "For example: Wrong profile", v => setReasons(reasons.map((x, j) => (j === i ? { key: x.key, label: v } : x))), () => setReasons(reasons.filter((_, j) => j !== i))))}
      <button className={btn} onClick={() => setReasons([...reasons, { key: null, label: "" }])}>Add a line</button>
    </div>
  )

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {done && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">The &quot;Good&quot; checklist</h2>
        <p className="mb-3 text-sm text-slate-500">What the setter taps on the call before marking a lead Good. Write the questions you want answered. Today it is empty, so the setter sees no ticks.</p>
        {checklistList}
        <button className={`${btn} mt-3 bg-slate-900 text-white`} disabled={busy === "qualification_checklist"} onClick={() => save("qualification_checklist", cleanChecklist(checklist), "Checklist saved. Setters see it on their next lead.")}>Save the checklist</button>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Reasons for &quot;Not in target&quot;</h2>
        <p className="mb-3 text-sm text-slate-500">The setter must pick one when a lead is not a fit. Leads already marked keep their reason when you rename or add lines.</p>
        {reasonsList}
        <button className={`${btn} mt-3 bg-slate-900 text-white`} disabled={busy === "not_in_target_reasons"} onClick={() => {
          const built = buildOptions(p.reasons, reasons)
          if (!built) { setError("Keep at least one reason."); return }
          void save("not_in_target_reasons", built, "Reasons saved.")
        }}>Save the reasons</button>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Switches</h2>
        <ul className="mt-2 divide-y">
          {SWITCH_LABELS.map(([k, label, hint]) => (
            <li key={k} className="flex items-center justify-between gap-4 py-3">
              <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-slate-500">{hint}</p></div>
              <button role="switch" aria-checked={sw[k]} aria-label={label} disabled={busy === k}
                className={`relative h-6 w-11 shrink-0 rounded-full border transition ${sw[k] ? "border-teal-700 bg-teal-700" : "bg-slate-100"}`}
                onClick={() => { const next = !sw[k]; setSw({ ...sw, [k]: next }); void save(k, next, `${label}: ${next ? "on" : "off"}.`) }}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${sw[k] ? "left-6" : "left-1 bg-slate-400"}`} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-600">Currencies a payment link may use</h2>
        <input aria-label="Currencies" className="mt-2 w-72 rounded-lg border px-3 py-2 text-sm" value={currencies} onChange={e => setCurrencies(e.target.value)} placeholder="USD, EUR" />
        <p className="mt-1 text-xs text-slate-500">Three-letter codes separated by commas.</p>
        <button className={`${btn} mt-3 bg-slate-900 text-white`} disabled={busy === "allowed_currencies"} onClick={() => save("allowed_currencies", currencies.split(/[\s,;]+/).map(c => c.trim().toUpperCase()).filter(Boolean), "Currencies saved.")}>Save the currencies</button>
      </section>
    </div>
  )
}
