"use client"

import { useState } from "react"

type Status = "ok" | "warn" | "fail" | "skip"
interface Check { key: string; label: string; status: Status; detail: string }
interface ImportDay { day: string; seen: number; alreadyHeld: number; added: number }
interface ImportResult { dryRun: boolean; forms: number; seen: number; alreadyHeld: number; added: number; days: ImportDay[]; stoppedEarly: boolean; errors: string[] }
interface SubscribeResult { pageId: string; ok: boolean; detail: string }

const DOT: Record<Status, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", fail: "bg-red-500", skip: "bg-slate-300" }

/** Antonio's two buttons: read-only "is Meta connected?" and the one-time "subscribe the Page". Server errors are shown, not swallowed (R099). */
export function MetaConnectionPanel() {
  const [busy, setBusy] = useState<"check" | "subscribe" | "connect" | "import" | null>(null)
  const [userKey, setUserKey] = useState("")
  const [showKeyBox, setShowKeyBox] = useState(false)
  const [connectSteps, setConnectSteps] = useState<Check[] | null>(null)
  const [connectOk, setConnectOk] = useState<boolean | null>(null)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [overall, setOverall] = useState<boolean | null>(null)
  const [subs, setSubs] = useState<SubscribeResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [imp, setImp] = useState<ImportResult | null>(null)
  const [counted, setCounted] = useState<string | null>(null)

  async function call<T>(path: string, fallback: string, json?: unknown): Promise<T> {
    const res = await fetch(path, { method: "POST", ...(json !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) } : {}) })
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(d.error || fallback)
    }
    return res.json() as Promise<T>
  }

  async function check(keepSubscribeResult = false) {
    setBusy("check"); setError(null)
    if (!keepSubscribeResult) setSubs(null)
    try {
      const r = await call<{ ok: boolean; checks: Check[] }>("/api/marketing-admin/meta/check", "The check could not run. Please try again.")
      setChecks(r.checks); setOverall(r.ok)
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "The check could not run. Please try again.") }
    finally { setBusy(null) }
  }

  async function subscribe() {
    if (!window.confirm("Tell Meta to send this Page's new leads to our system? This installs our app on the Page. It is safe to repeat.")) return
    setBusy("subscribe"); setError(null)
    try {
      const r = await call<{ results: SubscribeResult[] }>("/api/marketing-admin/meta/subscribe", "Subscribing failed. Please try again.")
      setSubs(r.results)
      await check(true)
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "Subscribing failed. Please try again.") }
    finally { setBusy(null) }
  }

  async function importHistory(dryRun: boolean) {
    setBusy("import"); setError(null)
    if (dryRun) setImp(null)
    try {
      const r = await call<ImportResult>("/api/marketing-admin/meta/import-history", "The import could not run. Please try again.", { from, to, dryRun })
      setImp(r)
      if (dryRun) setCounted(`${from}|${to}`)
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "The import could not run. Please try again.") }
    finally { setBusy(null) }
  }

  async function connect() {
    setBusy("connect"); setError(null); setSubs(null); setConnectSteps(null)
    try {
      const r = await call<{ ok: boolean; steps: Check[] }>("/api/marketing-admin/meta/connect", "Connecting failed. Please try again.", userKey.trim() ? { userKey: userKey.trim() } : {})
      setConnectSteps(r.steps); setConnectOk(r.ok)
      if (r.ok) setUserKey("")
      await check(true)
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "Connecting failed. Please try again.") }
    finally { setBusy(null) }
  }

  return (
    <div className="mt-4 border-t pt-4">
      <div className="flex flex-wrap gap-2">
        <button onClick={connect} disabled={busy !== null} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy === "connect" ? "Connecting…" : "Connect Meta"}
        </button>
        <button onClick={() => check()} disabled={busy !== null} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy === "check" ? "Checking…" : "Check the Meta connection"}
        </button>
        <button onClick={subscribe} disabled={busy !== null} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50">
          {busy === "subscribe" ? "Subscribing…" : "Subscribe the Page to new leads"}
        </button>
      </div>
      <div className="mt-2 text-sm">
        <button type="button" onClick={() => setShowKeyBox(v => !v)} className="text-slate-500 underline">{showKeyBox ? "Hide the key box" : "I have a fresh Facebook key to use"}</button>
        {showKeyBox && (
          <div className="mt-2">
            <textarea value={userKey} onChange={e => setUserKey(e.target.value)} rows={3} autoComplete="off" spellCheck={false}
              placeholder="Paste your Facebook key here (optional: without it, the key set on Vercel is used)"
              className="w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" />
            <p className="mt-1 text-xs text-slate-500">It is sent once to our server, used to make the Page&apos;s key, and never shown or saved as typed.</p>
          </div>
        )}
      </div>
      <div className="mt-4 border-t pt-4" data-testid="import-history">
        <p className="text-sm font-medium">Pull older leads from Meta</p>
        <p className="mt-1 text-xs text-slate-500">For leads that arrived before we were connected (Meta keeps them about 90 days). Count first, then import. A lead we already hold is never added twice.</p>
        <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col text-xs text-slate-500">From<input type="date" value={from} onChange={e => { setFrom(e.target.value); setCounted(null) }} className="mt-0.5 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900" /></label>
          <label className="flex flex-col text-xs text-slate-500">To (included)<input type="date" value={to} onChange={e => { setTo(e.target.value); setCounted(null) }} className="mt-0.5 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900" /></label>
          <button onClick={() => importHistory(true)} disabled={busy !== null || !from || !to} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === "import" && imp === null ? "Counting…" : "Count them"}</button>
          <button onClick={() => importHistory(false)} disabled={busy !== null || counted !== `${from}|${to}` || !imp || imp.added === 0} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === "import" && imp !== null ? "Importing…" : "Import them"}</button>
        </div>
        {imp && (
          <div className="mt-3 text-sm" data-testid="import-result">
            <p className="font-medium">{imp.dryRun ? `Found ${imp.seen} lead${imp.seen === 1 ? "" : "s"}: ${imp.added} new, ${imp.alreadyHeld} already here.` : `Imported ${imp.added} new lead${imp.added === 1 ? "" : "s"} (${imp.alreadyHeld} were already here).`}</p>
            {imp.days.length > 0 && <ul className="mt-1 space-y-0.5 text-slate-600">{imp.days.map(d => <li key={d.day}>{d.day}: {d.seen} seen, {d.added} {imp.dryRun ? "to add" : "added"}, {d.alreadyHeld} already here</li>)}</ul>}
            {imp.stoppedEarly && <p className="mt-1 text-amber-700">It stopped early to stay within the time limit — run it again to continue.</p>}
            {imp.errors.length > 0 && <ul className="mt-1 text-red-700">{imp.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        )}
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {connectSteps && (
        <div className="mt-3">
          <p className={`text-sm font-medium ${connectOk ? "text-emerald-700" : "text-red-700"}`}>{connectOk ? "Connected." : "Not connected yet."}</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {connectSteps.map(c => (
              <li key={c.key} className="flex gap-2">
                <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.status]}`} />
                <span><b>{c.label}:</b> {c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {subs && (
        <ul className="mt-3 space-y-1 text-sm">
          {subs.map(s => <li key={s.pageId} className={s.ok ? "text-emerald-700" : "text-red-700"}>Page {s.pageId}: {s.detail}</li>)}
        </ul>
      )}
      {checks && (
        <div className="mt-3">
          <p className={`text-sm font-medium ${overall ? "text-emerald-700" : "text-amber-700"}`}>{overall ? "Meta is connected." : "Not fully connected yet."}</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {checks.map(c => (
              <li key={c.key} className="flex gap-2">
                <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.status]}`} />
                <span><b>{c.label}:</b> {c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
