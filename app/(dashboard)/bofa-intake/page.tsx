"use client"

/**
 * /bofa-intake — every one-time bank-application link in one list (dev job 11d484a4): which partner it
 * was made for, who it ended up with (read from the submitted form), when it was opened and submitted,
 * which addresses it was emailed to, and the answers and documents. Links are made on the Forms page.
 */

import { Suspense, useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { BOFA_TEXT_FIELDS } from "@/lib/bofa-intake/schema"

type LinkStatus = "pending" | "opened" | "completed" | "revoked"
interface LinkRow {
  id: string
  label: string
  partner_name: string | null
  recipients: string[] | null
  email_status: "sending" | "sent" | "failed" | null
  email_sent_at: string | null
  email_error: string | null
  status: LinkStatus
  url: string
  created_at: string
  opened_at: string | null
  completed_at: string | null
  client_name: string | null
  client_company: string | null
  store_owner_id: string | null
  store_folder_id: string | null
  store_archived_at: string | null
  store_error: string | null
}
interface Detail {
  id: string
  label: string
  partner_name: string | null
  recipients: string[] | null
  email_status: string | null
  email_sent_at: string | null
  email_error: string | null
  status: string
  completed_at: string | null
  store_owner_id: string | null
  store_folder_id: string | null
  store_archived_at: string | null
  store_error: string | null
  form_data: Record<string, string> | null
  files: { key: string; label: string; name: string; url: string | null }[]
}

const STATUS_TEXT: Record<LinkStatus, string> = {
  pending: "Not opened yet",
  opened: "Opened, not submitted",
  completed: "Submitted",
  revoked: "Revoked",
}
const STATUS_CLS: Record<LinkStatus, string> = {
  pending: "bg-gray-100 text-gray-700",
  opened: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  revoked: "bg-red-100 text-red-700",
}

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—"
}

function emailCell(l: LinkRow) {
  const to = l.recipients ?? []
  if (to.length === 0) return <span className="text-muted-foreground">Not emailed (no address set)</span>
  const list = <>{to.map((e) => <span key={e} className="block break-all">{e}</span>)}</>
  if (l.status !== "completed") return <>{list}<span className="block text-xs text-muted-foreground">Sent when submitted</span></>
  if (l.email_status === "sent") return <>{list}<span className="block text-xs text-green-700">Sent {fmt(l.email_sent_at)}</span></>
  if (l.email_status === "failed") return <>{list}<span className="block text-xs text-red-700">Not sent{l.email_error ? `: ${l.email_error}` : ""}</span></>
  if (l.email_status === "sending") return <>{list}<span className="block text-xs text-amber-700">Sending…</span></>
  return <>{list}<span className="block text-xs text-amber-700">Not sent yet</span></>
}

/** The new storage opened straight on the application's folder. */
function storageHref(ownerId: string | null, folderId: string): string {
  return `/storage?store=new&owner=${ownerId ?? ""}&folder=${folderId}`
}

function storageCell(l: LinkRow) {
  if (l.status !== "completed") return <span className="text-muted-foreground">After it is submitted</span>
  if (l.store_archived_at && l.store_folder_id) {
    return (
      <>
        <span className="block text-xs text-green-700">Saved {fmt(l.store_archived_at)}</span>
        <span className="block text-xs text-muted-foreground">Business › BofA</span>
        <Link href={storageHref(l.store_owner_id, l.store_folder_id)} className="text-xs underline">Open in Storage</Link>
      </>
    )
  }
  return <span className="block text-xs text-red-700">Not saved yet{l.store_error ? `: ${l.store_error}` : ""}</span>
}

function BofaIntakeInner() {
  const search = useSearchParams()
  const [links, setLinks] = useState<LinkRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const load = useCallback(async () => {
    const res = await fetch("/api/bofa-intake-admin", { cache: "no-store" })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) setError(d.error || "Could not load the links.")
    else setLinks(d.links ?? [])
    setLoaded(true)
  }, [])

  const openDetail = useCallback(async (id: string) => {
    setError("")
    const res = await fetch(`/api/bofa-intake-admin/${id}`, { cache: "no-store" })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) return setError(d.error || "Could not open that application.")
    setDetail(d.link)
  }, [])

  useEffect(() => {
    load()
    const open = search.get("open")
    if (open) openDetail(open)
  }, [load, openDetail, search])

  async function act(id: string, action: "revoke" | "reset_lock" | "resend_email" | "archive", confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setError("")
    setNotice("")
    const res = await fetch(`/api/bofa-intake-admin/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) setError(d.error || "That did not work. Please try again.")
    else if (action === "resend_email") setNotice(`Emailed to ${(d.sent_to ?? []).join(", ")}.`)
    else if (action === "archive") setNotice("Saved in Storage: Business › BofA.")
    await load()
    if (detail?.id === id) openDetail(id)
  }

  async function copy(url: string) {
    setError("")
    try {
      await navigator.clipboard.writeText(url)
      setNotice("Link copied.")
    } catch {
      setError("Could not copy. Open the link's row and copy it by hand.")
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-semibold">Bank application: links and submissions</h1>
        <Link href="/forms" className="h-9 px-4 inline-flex items-center rounded-md border text-sm shrink-0">Make a new link</Link>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Every one-time link: who it was made for, who it reached once submitted, when, where it was emailed, and what they sent.
      </p>

      {error && <div className="rounded-md bg-red-50 text-red-700 text-sm p-3 mb-4" role="alert">{error}</div>}
      {notice && <div className="rounded-md bg-green-50 text-green-800 text-sm p-3 mb-4">{notice}</div>}

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Partner</th>
              <th className="p-3 font-medium">Shared with (client)</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Created</th>
              <th className="p-3 font-medium">Opened</th>
              <th className="p-3 font-medium">Submitted</th>
              <th className="p-3 font-medium">Saved in Storage</th>
              <th className="p-3 font-medium">Emailed to</th>
              <th className="p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loaded && links.length === 0 && (
              <tr><td className="p-4 text-muted-foreground" colSpan={9}>No links yet. Make one from the Forms page.</td></tr>
            )}
            {links.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="p-3 min-w-[90px]">{l.partner_name ? <span className="font-medium">{l.partner_name}</span> : <span className="text-muted-foreground">No partner (direct)</span>}</td>
                <td className="p-3">
                  {l.client_name ? (
                    <>
                      <span className="block">{l.client_name}</span>
                      {l.client_company && <span className="block text-xs text-muted-foreground">{l.client_company}</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{l.status === "revoked" ? "—" : "Fills in when submitted"}</span>
                  )}
                </td>
                <td className="p-3"><span className={`text-xs rounded px-2 py-0.5 whitespace-nowrap ${STATUS_CLS[l.status]}`}>{STATUS_TEXT[l.status]}</span></td>
                <td className="p-3 min-w-[110px]">{fmt(l.created_at)}</td>
                <td className="p-3 min-w-[110px]">{fmt(l.opened_at)}</td>
                <td className="p-3 min-w-[110px]">{fmt(l.completed_at)}</td>
                <td className="p-3 min-w-[150px]">{storageCell(l)}</td>
                <td className="p-3 min-w-[200px]">{emailCell(l)}</td>
                <td className="p-3">
                  <div className="flex flex-col gap-1 items-start">
                    {l.status === "completed" && <button className="text-xs underline" onClick={() => openDetail(l.id)}>View answers and documents</button>}
                    {l.status === "completed" && !l.store_archived_at && (
                      <button className="text-xs underline" onClick={() => act(l.id, "archive")}>Save to Storage</button>
                    )}
                    {l.status === "completed" && (l.recipients?.length ?? 0) > 0 && (
                      <button
                        className="text-xs underline"
                        onClick={() => act(l.id, "resend_email", l.email_status === "sent" ? "This was already emailed. Send it again to the same address(es)?" : undefined)}
                      >
                        {l.email_status === "sent" ? "Email again" : "Resend email"}
                      </button>
                    )}
                    {(l.status === "pending" || l.status === "opened") && <button className="text-xs underline" onClick={() => copy(l.url)}>Copy link</button>}
                    {l.status === "opened" && (
                      <button className="text-xs underline" onClick={() => act(l.id, "reset_lock", "Reset this link? It goes back to 'not opened', and anything the first person uploaded is deleted. Use it when the client switched browser or cleared cookies.")}>Reset</button>
                    )}
                    {(l.status === "pending" || l.status === "opened") && (
                      <button className="text-xs underline text-red-700" onClick={() => act(l.id, "revoke", "Revoke this link? Nobody will be able to use it.")}>Revoke</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="border rounded-lg p-4 mt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-medium">{detail.form_data?.full_name || detail.label}{detail.form_data?.company_name ? ` — ${detail.form_data.company_name}` : ""}</h2>
            <button className="text-xs underline" onClick={() => setDetail(null)}>Close</button>
          </div>
          <p className="text-xs text-muted-foreground mb-1">Partner: {detail.partner_name || "none (direct)"} · Submitted {fmt(detail.completed_at)}</p>
          <p className="text-xs text-muted-foreground mb-1">
            {detail.store_archived_at && detail.store_folder_id ? (
              <>Saved in Storage (Business › BofA) on {fmt(detail.store_archived_at)}. <Link href={storageHref(detail.store_owner_id, detail.store_folder_id)} className="underline">Open the folder</Link></>
            ) : (
              <>Not saved in Storage yet{detail.store_error ? `: ${detail.store_error}` : ""}.</>
            )}
          </p>
          <p className="text-xs text-muted-foreground mb-3">
            {(detail.recipients?.length ?? 0) === 0
              ? "Not emailed (no address was set for this link)."
              : detail.email_status === "sent"
                ? `Emailed to ${detail.recipients?.join(", ")} on ${fmt(detail.email_sent_at)}.`
                : detail.email_status === "failed"
                  ? `Email to ${detail.recipients?.join(", ")} was NOT sent${detail.email_error ? `: ${detail.email_error}` : ""}.`
                  : `Email to ${detail.recipients?.join(", ")} has not been sent.`}
          </p>
          <table className="w-full text-sm mb-4">
            <tbody>
              {BOFA_TEXT_FIELDS.map((f) => (
                <tr key={f.key} className="border-t align-top">
                  <td className="py-1.5 pr-3 text-muted-foreground w-56">{f.label}</td>
                  <td className="py-1.5 whitespace-pre-wrap break-words">{detail.form_data?.[f.key] || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="text-sm font-medium mb-2">Documents</h3>
          <ul className="text-sm space-y-1">
            {detail.files.map((f) => (
              <li key={f.key + f.name}>
                {f.label}: {f.url ? <a className="underline" href={f.url}>{f.name}</a> : f.name}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground mt-3">Download links last one hour. The same files are in Storage.</p>
        </div>
      )}
    </div>
  )
}

export default function BofaIntakePage() {
  return (
    <Suspense fallback={null}>
      <BofaIntakeInner />
    </Suspense>
  )
}
