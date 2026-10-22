"use client"

/** The owner's panel on /tools/storage-app: publish a new app version (two files from the signing script) and offer it to the Macs / pause it. */
import { useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"

const BUCKET = "app-releases"
type Current = { version: string; build: number; enabled: boolean; rolloutPercent: number } | null

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof d.error === "string" && d.error ? d.error : "That did not work. Please try again.")
  return d
}

export function ReleasePanel({ current }: { current: Current }) {
  const router = useRouter()
  const [zip, setZip] = useState<File | null>(null)
  const [pkg, setPkg] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function publish() {
    if (!zip || !pkg) return
    setBusy(true); setNote(null)
    try {
      const parsed = JSON.parse(await pkg.text())
      const prep = (await post("/api/store-devices/app-release/prepare", { version: parsed.version, build: parsed.build, length: parsed.length })) as { path: string; token: string }
      const up = await createClient().storage.from(BUCKET).uploadToSignedUrl(prep.path, prep.token, zip)
      if (up.error) throw new Error("The upload did not work. Please try again.")
      const done = await post("/api/store-devices/app-release/finish", { package: parsed })
      setNote({ ok: true, text: `Version ${done.version} is published but NOT offered to the Macs yet. Press “Offer to Macs” when you are ready.` })
      setZip(null); setPkg(null)
      router.refresh()
    } catch (e) {
      setNote({ ok: false, text: e instanceof SyntaxError ? "That package file could not be read." : e instanceof Error && e.message ? e.message : "That did not work. Please try again." })
    }
    setBusy(false)
  }

  async function offer(change: { enabled?: boolean; rolloutPercent?: number }) {
    setBusy(true); setNote(null)
    try { await post("/api/store-devices/app-release/offer", change); router.refresh() }
    catch (e) { setNote({ ok: false, text: e instanceof Error && e.message ? e.message : "That did not work. Please try again." }) }
    setBusy(false)
  }

  const btn = "inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
  return (
    <div className="rounded-lg border bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-800">Publish (owner only)</h2>
      {current && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-700">
          <span>Version {current.version} (build {current.build}):</span>
          <span className={current.enabled ? "font-medium text-green-700" : "font-medium text-amber-700"}>{current.enabled ? `offered to Macs at ${current.rolloutPercent}%` : "NOT offered (paused)"}</span>
          {current.enabled
            ? <button className={`${btn} hover:bg-amber-50`} disabled={busy} onClick={() => offer({ enabled: false })}>Pause</button>
            : <button className={`${btn} hover:bg-green-50`} disabled={busy} onClick={() => offer({ enabled: true })}>Offer to Macs</button>}
          {current.enabled && current.rolloutPercent < 100 && <button className={`${btn} hover:bg-blue-50`} disabled={busy} onClick={() => offer({ rolloutPercent: 100 })}>Offer to all (100%)</button>}
        </div>
      )}
      <div className="mt-4 space-y-2 text-sm">
        <div className="font-medium text-zinc-800">New version</div>
        <label className="block text-xs text-zinc-600">The zip file<input type="file" accept=".zip" className="mt-1 block text-xs" onChange={(e) => setZip(e.target.files?.[0] ?? null)} /></label>
        <label className="block text-xs text-zinc-600">The package file (ends in .release.json)<input type="file" accept=".json" className="mt-1 block text-xs" onChange={(e) => setPkg(e.target.files?.[0] ?? null)} /></label>
        <button className={`${btn} bg-blue-600 text-white hover:bg-blue-700`} disabled={busy || !zip || !pkg} onClick={publish}>{busy ? "Working…" : "Publish (paused)"}</button>
      </div>
      {note && <p className={`mt-3 text-sm ${note.ok ? "text-green-700" : "text-red-700"}`}>{note.text}</p>}
    </div>
  )
}
