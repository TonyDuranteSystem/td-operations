"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/** For one team: the kill switch and the owner invitation. Every server answer, including a refusal, is shown as written (R099). */
export function TeamControls({ teamId, status, hasOwner, iAmMember }: { teamId: string; status: "draft" | "active" | "paused"; hasOwner: boolean; iAmMember: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [link, setLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null)

  async function call(url: string, method: string, body: unknown, fallback: string) {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok) throw new Error(typeof d.error === "string" && d.error ? d.error : fallback)
      return d
    } catch (e) { setError(e instanceof Error && e.message ? e.message : fallback); return null } finally { setBusy(false) }
  }

  async function setStatus(to: "active" | "paused") {
    const d = await call(`/api/marketing-admin/teams/${teamId}/status`, "PATCH", { status: to }, "Could not change the team. Please try again.")
    if (d) { setDone(to === "active" ? "The team is on. Its people can work." : "The team is paused. Nobody on it can work until you switch it on."); router.refresh() }
  }
  async function addMe() {
    const d = await call(`/api/marketing-admin/teams/${teamId}/add-me`, "POST", {}, "Could not add you to the team. Please try again.")
    if (d) { setDone("You are now an owner of this team. Open Marketing team in the menu to go straight in: you are a person in its chat now."); router.refresh() }
  }
  async function invite() {
    const d = await call(`/api/marketing-admin/teams/${teamId}/owner-invite`, "POST", { email }, "Could not create the invitation. Please try again.")
    if (d) { setLink({ url: String(d.inviteUrl), email: String(d.email ?? email), expiresAt: String(d.expiresAt) }); setEmail(""); router.refresh() }
  }

  const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50"
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status !== "active" && <button className={`${btn} bg-emerald-700 text-white`} disabled={busy} onClick={() => setStatus("active")}>{status === "draft" ? "Switch the team on" : "Resume the team"}</button>}
        {status === "active" && <button className={`${btn} text-rose-700`} disabled={busy} onClick={() => setStatus("paused")}>Pause the team (stops every login and link)</button>}
      </div>
      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">You, in this team</p>
        {iAmMember
          ? <p className="mt-1 text-sm text-slate-600">You are an owner of this team: open <b>Marketing team</b> in the menu to go straight in. &quot;View as&quot; above still shows you what each role sees.</p>
          : <>
              <p className="mt-1 text-xs text-slate-500">Join as an owner (with your own login, no invitation): the workspace opens without &quot;View as&quot;, and you are a person in the team&apos;s chat that Rocco and the others can write to.</p>
              <button className={`${btn} mt-2 bg-slate-900 text-white`} disabled={busy} data-testid="add-me" onClick={addMe}>Add me to this team as owner</button>
            </>}
      </div>
      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">{hasOwner ? "Invite another team owner" : "Invite the team owner (Rocco)"}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="Owner email" type="email" className="w-72 rounded-lg border px-3 py-2 text-sm" placeholder="rocco@tonydurante.us" value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" />
          <button className={`${btn} bg-slate-900 text-white`} disabled={busy || !email.trim()} onClick={invite}>Create invitation link</button>
        </div>
        <p className="mt-1 text-xs text-slate-500">You get a one-time link to send him yourself. It works for 7 days, once.</p>
      </div>
      {link && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm" aria-label="Invitation link">
          <p className="font-medium">Invitation for {link.email}</p>
          <p className="text-slate-700">Send him this link. It is shown only now and cannot be shown again (cancel it and make a new one if lost).</p>
          <input readOnly aria-label="Invitation link" className="mt-2 w-full rounded-lg border bg-white px-3 py-2 text-xs" value={link.url} onFocus={e => e.currentTarget.select()} />
          <button className={`${btn} mt-2`} onClick={() => { void navigator.clipboard?.writeText(link.url).then(() => setDone("Link copied.")).catch(() => setError("Could not copy. Select the link and copy it.")) }}>Copy link</button>
        </div>
      )}
      {done && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </div>
  )
}
