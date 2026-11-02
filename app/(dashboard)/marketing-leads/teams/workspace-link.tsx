"use client"

import { useState } from "react"

/** The permanent link to the team workspace, to copy and send to anyone who is on the team (they sign in with their own email and password). Dev job 9aec66fa. */
export function WorkspaceLink({ url }: { url: string }) {
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">Workspace link</p>
      <p className="mt-1 text-xs text-slate-500">Send this link to anyone who is on the team. They sign in with their own email and password.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input readOnly aria-label="Workspace link" className="min-w-0 flex-1 rounded-lg border bg-slate-50 px-3 py-2 text-xs" value={url} onFocus={e => e.currentTarget.select()} />
        <button type="button" className="rounded-lg border px-3 py-2 text-sm font-medium" data-testid="copy-workspace-link"
          onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setError(null); setMsg("Link copied.") }).catch(() => { setMsg(null); setError("Could not copy. Select the link and copy it.") }) }}>Copy link</button>
      </div>
      {msg && <p role="status" className="mt-2 text-sm text-emerald-800">{msg}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-rose-800">{error}</p>}
    </div>
  )
}
