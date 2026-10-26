"use client"

import { useState } from "react"

type Row = { id: string; user_id: string; email: string | null; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; app_version?: string | null; app_build?: number | null }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never")

export function DevicesList({ rows: initial, owner, selfId }: { rows: Row[]; owner: boolean; selfId: string }) {
  const [rows, setRows] = useState(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function post(url: string, body: unknown): Promise<boolean> {
    setError(null)
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "That did not work. Please try again.")
      }
      return true
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That did not work. Please try again.")
      return false
    }
  }

  async function signOut(id: string) {
    setBusy(id)
    if (await post("/api/store-devices/revoke", { deviceId: id })) setRows((r) => r.map((x) => (x.id === id ? { ...x, revoked_at: new Date().toISOString() } : x)))
    setBusy(null)
  }

  async function signOutAll() {
    if (!window.confirm("Sign out EVERY Mac that uses TD Storage?")) return
    setBusy("all")
    if (await post("/api/store-devices/revoke-all", {})) setRows((r) => r.map((x) => (x.revoked_at ? x : { ...x, revoked_at: new Date().toISOString() })))
    setBusy(null)
  }

  const active = rows.filter((r) => !r.revoked_at)
  return (
    <div className="mt-4 space-y-3 text-sm">
      {owner && active.length > 0 ? (
        <button className="rounded-md border px-3 py-1.5 disabled:opacity-60" disabled={busy !== null} onClick={signOutAll}>Sign out all Macs</button>
      ) : null}
      {error ? <p className="text-red-600">{error}</p> : null}
      {rows.length === 0 ? <p className="text-muted-foreground">No Mac has signed in yet.</p> : (
        <table className="w-full text-left">
          <thead className="text-muted-foreground"><tr><th className="py-1">Mac</th>{owner ? <th>Person</th> : null}<th>Signed in</th><th>Last seen</th><th>App</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-2">{r.name}{r.revoked_at ? <span className="ml-2 text-muted-foreground">(signed out)</span> : null}</td>
                {owner ? <td>{r.email ?? r.user_id}{r.user_id === selfId ? " (you)" : ""}</td> : null}
                <td>{when(r.created_at)}</td>
                <td>{when(r.last_seen_at)}</td>
                <td>{r.app_version ? `${r.app_version} (${r.app_build ?? "?"})` : "not reported"}</td>
                <td className="text-right">
                  {r.revoked_at ? null : <button className="rounded-md border px-2 py-1 disabled:opacity-60" disabled={busy !== null} onClick={() => signOut(r.id)}>{busy === r.id ? "Signing out…" : "Sign out"}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
