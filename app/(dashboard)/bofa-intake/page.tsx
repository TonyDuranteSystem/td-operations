"use client"

/**
 * /bofa-intake — every one-time bank-application link in one list (dev job 11d484a4): which partner it
 * was made for, who it ended up with (read from the submitted form), when it was opened and submitted, and what they sent.
 * Links are made on the Forms page.
 *
 * A submitted application WAITS for us (Antonio 2026-11-02): each one has Reviewed, Submit to <bank contact> and Send back.
 * Submit only works after Reviewed (the server enforces it), and its confirm box shows exactly what goes where. Sending back
 * writes a note and makes a NEW one-time link for the client; the old application stays on record.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { BOFA_TEXT_FIELDS } from "@/lib/bofa-intake/schema"
import { BOFA_SHIPPING_FIELDS } from "@/lib/bofa-intake/shipping"
import { REVIEW_STATE_TEXT, canMarkReviewed, canSendBack, canSubmit, canUndoSendBack, isStaleSending, reviewState, sendMayHaveGoneOut } from "@/lib/bofa-intake/review-state"

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
  updated_at: string | null
  notified_at: string | null
  opened_at: string | null
  completed_at: string | null
  client_name: string | null
  client_company: string | null
  store_owner_id: string | null
  store_folder_id: string | null
  store_archived_at: string | null
  store_error: string | null
  reviewed_at?: string | null
  reviewed_by?: string | null
  sent_by?: string | null
  sent_to?: string[] | null
  returned_at?: string | null
  returned_by?: string | null
  return_note?: string | null
  replaces_id?: string | null
}
interface Detail extends Omit<LinkRow, "url" | "client_name" | "client_company"> {
  form_data: Record<string, string> | null
  files: { key: string; label: string; name: string; url: string | null }[]
  staff_note?: string | null
}
interface SubmitSettings {
  submit_to: string[]
}

const STATUS_TEXT: Record<LinkStatus, string> = {
  pending: "Not opened yet",
  opened: "Opened, not submitted",
  completed: "Submitted by the client",
  revoked: "Revoked",
}
const STATUS_CLS: Record<LinkStatus, string> = {
  pending: "bg-gray-100 text-gray-700",
  opened: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  revoked: "bg-red-100 text-red-700",
}

function fmt(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—"
}

/** The "where is it on its way out" cell. */
function reviewCell(l: LinkRow, links: LinkRow[]) {
  if (l.status !== "completed") {
    return <span className="text-muted-foreground">{l.status === "revoked" ? "—" : "Waiting for the client"}</span>
  }
  const state = reviewState(l)
  if (!state) return null
  const text = REVIEW_STATE_TEXT[state]
  if (state === "needs_review") {
    return (
      <>
        <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800 whitespace-nowrap">{text}</span>
        {!l.notified_at && <span className="block text-xs text-amber-700 mt-1">The email to our team about this one did not go out.</span>}
      </>
    )
  }
  if (state === "ready") {
    return (
      <>
        <span className="text-xs rounded px-2 py-0.5 bg-blue-100 text-blue-800 whitespace-nowrap">{text}</span>
        <span className="block text-xs text-muted-foreground mt-1">Reviewed by {l.reviewed_by ?? "staff"} · {fmt(l.reviewed_at)}</span>
      </>
    )
  }
  if (state === "sending") {
    return (
      <>
        <span className="text-xs text-amber-700">{text}</span>
        {isStaleSending(l) && <span className="block text-xs text-red-700 mt-1">This has not finished for over 5 minutes. The email may already have reached the bank contact: check the Sent mailbox before submitting again.</span>}
      </>
    )
  }
  if (state === "send_failed") {
    return (
      <>
        <span className="text-xs rounded px-2 py-0.5 bg-red-100 text-red-700 whitespace-nowrap">{text}</span>
        {l.email_error && <span className="block text-xs text-red-700 mt-1">{l.email_error}</span>}
      </>
    )
  }
  if (state === "sent") {
    // Applications emailed under the OLD rule have no sent_to: the addresses saved on the link were used.
    const to = l.sent_to?.length ? l.sent_to : (l.recipients ?? [])
    return (
      <>
        <span className="text-xs rounded px-2 py-0.5 bg-green-100 text-green-800 whitespace-nowrap">{text}</span>
        {to.map((e) => <span key={e} className="block text-xs break-all mt-1">{e}</span>)}
        <span className="block text-xs text-muted-foreground">{fmt(l.email_sent_at)}{l.sent_by ? ` · by ${l.sent_by}` : ""}</span>
      </>
    )
  }
  // sent_back
  const replacement = links.find((x) => x.replaces_id === l.id && x.status !== "revoked") ?? links.find((x) => x.replaces_id === l.id)
  return (
    <>
      <span className="text-xs rounded px-2 py-0.5 bg-purple-100 text-purple-800 whitespace-nowrap">{text}</span>
      {l.email_status === "sent" && <span className="block text-xs text-amber-800 mt-1">Earlier submitted to {(l.sent_to?.length ? l.sent_to : (l.recipients ?? [])).join(", ")} · {fmt(l.email_sent_at)}</span>}
      <span className="block text-xs text-muted-foreground mt-1">{fmt(l.returned_at)}{l.returned_by ? ` · by ${l.returned_by}` : ""}</span>
      {l.return_note && <span className="block text-xs mt-1 whitespace-pre-wrap">&ldquo;{l.return_note}&rdquo;</span>}
      {replacement && <span className="block text-xs text-muted-foreground mt-1">New link: {STATUS_TEXT[replacement.status]}</span>}
    </>
  )
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 mb-3">
          <h2 className="text-base font-medium">{title}</h2>
          <button className="text-xs underline shrink-0" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function BofaIntakeInner() {
  const search = useSearchParams()
  const [links, setLinks] = useState<LinkRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reviewReady, setReviewReady] = useState(true)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [settings, setSettings] = useState<SubmitSettings | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  // one quick action at a time: a double click on Reviewed must not show an "already reviewed" error for the click that worked
  // (a ref, not state: the second click can arrive before React has re-rendered)
  const acting = useRef(false)
  // the two dialogs: Submit (shows what goes where) and Send back (a required note)
  const [submitFor, setSubmitFor] = useState<Detail | null>(null)
  const [sendBackFor, setSendBackFor] = useState<{ id: string; who: string } | null>(null)
  const [note, setNote] = useState("")
  const [dialogError, setDialogError] = useState("")
  const [newLink, setNewLink] = useState<{ url: string; error: string; linkOnly?: boolean } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch("/api/bofa-intake-admin", { cache: "no-store" })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) setError(d.error || "Could not load the links.")
    else {
      setLinks(d.links ?? [])
      setReviewReady(d.review_ready !== false)
    }
    setLoaded(true)
  }, [])

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/bofa-intake-admin/settings", { cache: "no-store" })
    const d = await res.json().catch(() => ({}))
    if (res.ok) setSettings({ submit_to: d.submit_to ?? [] })
  }, [])

  const fetchDetail = useCallback(async (id: string): Promise<Detail | null> => {
    setError("")
    const res = await fetch(`/api/bofa-intake-admin/${id}`, { cache: "no-store" })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(d.error || "Could not open that application.")
      return null
    }
    return d.link as Detail
  }, [])

  const openDetail = useCallback(async (id: string) => {
    const d = await fetchDetail(id)
    if (d) setDetail(d)
  }, [fetchDetail])

  useEffect(() => {
    load()
    loadSettings()
    const open = search.get("open")
    if (open) openDetail(open)
  }, [load, loadSettings, openDetail, search])

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/bofa-intake-admin/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const d = await res.json().catch(() => ({}))
    return { ok: res.ok, d }
  }

  async function refresh(id: string) {
    await load()
    if (detail?.id === id) openDetail(id)
  }

  async function act(id: string, action: "revoke" | "reset_lock" | "archive" | "review" | "undo_send_back", confirmText?: string) {
    if (acting.current) return
    if (confirmText && !window.confirm(confirmText)) return
    acting.current = true
    setError("")
    setNotice("")
    try {
      const { ok, d } = await patch(id, { action })
      if (!ok) setError(d.error || "That did not work. Please try again.")
      else if (action === "archive") setNotice("Saved in Storage: Business › BofA.")
      else if (action === "review") setNotice("Marked Reviewed. You can now submit it.")
      else if (action === "undo_send_back") setNotice("Send back undone. The application is back where it was.")
      await refresh(id)
    } finally {
      acting.current = false
    }
  }

  async function startSubmit(id: string) {
    setError("")
    setNotice("")
    await loadSettings()
    const d = await fetchDetail(id)
    if (d) {
      setDialogError("")
      setSubmitFor(d)
    }
  }

  async function confirmSubmit() {
    if (!submitFor || !settings) return
    setBusy(true)
    setDialogError("")
    const { ok, d } = await patch(submitFor.id, { action: "submit", confirm_to: settings.submit_to })
    setBusy(false)
    if (!ok) return setDialogError(d.error || "That did not work. Please try again.")
    const id = submitFor.id
    setSubmitFor(null)
    setNotice(`Submitted to ${(d.sent_to ?? []).join(", ")}.`)
    await refresh(id)
  }

  function startSendBack(id: string, who: string) {
    setError("")
    setNotice("")
    setNote("")
    setDialogError("")
    setNewLink(null)
    setSendBackFor({ id, who })
  }

  // emailIt=false is "Create link only": the new link is made but nothing is emailed, so staff can share it by WhatsApp or any other way.
  async function confirmSendBack(emailIt = true) {
    if (!sendBackFor) return
    setBusy(true)
    setDialogError("")
    const { ok, d } = await patch(sendBackFor.id, emailIt ? { action: "send_back", note } : { action: "send_back", note, email: false })
    setBusy(false)
    if (!ok) return setDialogError(d.error || "That did not work. Please try again.")
    const id = sendBackFor.id
    if (d.link_only) {
      setNewLink({ url: d.url, error: "", linkOnly: true })
    } else if (d.emailed) {
      setSendBackFor(null)
      setNotice(`Sent back. A new link was emailed to ${d.emailed_to}.`)
    } else {
      // The new link exists; only the email failed. Keep the dialog open on the link so it can be copied.
      setNewLink({ url: d.url, error: d.email_error || "The email could not be sent." })
    }
    await refresh(id)
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

  const off = !reviewReady

  // "Undo send back": offered while nobody is working on the new link (never opened, or already revoked).
  function undoSendBackButton(l: { id: string; status: string; email_status: string | null; reviewed_at?: string | null; returned_at?: string | null }, cls: string) {
    const replacements = links.filter((x) => x.replaces_id === l.id)
    if (!canUndoSendBack(l, replacements)) return null
    const waiting = replacements.some((x) => x.status !== "revoked")
    const text = waiting
      ? "Undo this send back? The new link stops working, and the application goes back to where it was before. Nothing is emailed. If you already emailed the client, they keep that email, but its link will no longer work."
      : "Undo this send back? The application goes back to where it was before. Nothing is emailed."
    return <button className={cls} disabled={off} onClick={() => act(l.id, "undo_send_back", text)}>Undo send back</button>
  }

  function reviewButtons(l: LinkRow) {
    if (l.status !== "completed") return null
    return (
      <>
        {canMarkReviewed(l) && <button className="text-xs underline" disabled={off} onClick={() => act(l.id, "review")}>Reviewed</button>}
        {canSubmit(l) && (
          <button className="text-xs underline font-medium" disabled={off || !settings} onClick={() => startSubmit(l.id)}>
            {reviewState(l) === "ready" ? "Submit to bank contact" : "Submit again"}
          </button>
        )}
        {canSendBack(l) && (
          <button className="text-xs underline" disabled={off} onClick={() => startSendBack(l.id, l.client_name || l.label)}>Send back to client</button>
        )}
        {/* Sent back, but the client's new link was cancelled: nothing is waiting on the client, so it may be sent back again. */}
        {reviewState(l) === "sent_back" && (() => {
          const replacements = links.filter((x) => x.replaces_id === l.id)
          return !replacements.some((x) => x.status !== "revoked")
        })() && (
          <button className="text-xs underline" disabled={off} onClick={() => startSendBack(l.id, l.client_name || l.label)}>Send back again</button>
        )}
        {undoSendBackButton(l, "text-xs underline")}
      </>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-semibold">Bank application: links and submissions</h1>
        <Link href="/forms" className="h-9 px-4 inline-flex items-center rounded-md border text-sm shrink-0">Make a new link</Link>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Every one-time link: who it was made for, who it reached once submitted, when, and what they sent. A submitted application waits here until we mark it Reviewed and submit it.
      </p>

      {off && (
        <div className="rounded-md bg-amber-50 text-amber-900 text-sm p-3 mb-4" role="status">
          A database step for the review buttons has not been run on this system yet. You can read every application; Reviewed, Submit and Send back are off until it is.
        </div>
      )}
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
              <th className="p-3 font-medium">Review / sent to the bank contact</th>
              <th className="p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loaded && links.length === 0 && (
              <tr><td className="p-4 text-muted-foreground" colSpan={9}>No links yet. Make one from the Forms page.</td></tr>
            )}
            {links.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="p-3 min-w-[90px]">
                  {l.partner_name ? <span className="font-medium">{l.partner_name}</span> : <span className="text-muted-foreground">No partner (direct)</span>}
                  {l.replaces_id && <span className="block text-xs text-purple-700 mt-1">Replaces an earlier application</span>}
                </td>
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
                <td className="p-3 min-w-[200px]">{reviewCell(l, links)}</td>
                <td className="p-3">
                  <div className="flex flex-col gap-1 items-start">
                    {l.status === "completed" && <button className="text-xs underline" onClick={() => openDetail(l.id)}>View answers and documents</button>}
                    {reviewButtons(l)}
                    {l.status === "completed" && !l.store_archived_at && (
                      <button className="text-xs underline" onClick={() => act(l.id, "archive")}>Save to Storage</button>
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
            {(() => {
              const state = reviewState(detail)
              if (!state) return "Not submitted by the client yet."
              if (state === "needs_review") return "Waiting for review. Nothing has been sent to the bank contact."
              if (state === "ready") return `Reviewed by ${detail.reviewed_by ?? "staff"} on ${fmt(detail.reviewed_at)}. Not submitted yet.`
              if (state === "sending") return isStaleSending(detail) ? "The last submit has not finished for over 5 minutes. The email may already have reached the bank contact: check the Sent mailbox before submitting again." : "Being submitted right now…"
              if (state === "send_failed") {
                // Only say "did NOT go through" when that is known; a failure Gmail never confirmed may have gone out.
                if (sendMayHaveGoneOut(detail)) return `The last submit ended with an error. ${detail.email_error}`
                return `The last submit did NOT go through${detail.email_error ? `: ${detail.email_error}` : ""}.`
              }
              if (state === "sent") return `Submitted to ${(detail.sent_to?.length ? detail.sent_to : (detail.recipients ?? [])).join(", ")} on ${fmt(detail.email_sent_at)}${detail.sent_by ? ` by ${detail.sent_by}` : ""}.`
              return `Sent back to the client on ${fmt(detail.returned_at)}${detail.returned_by ? ` by ${detail.returned_by}` : ""}${detail.return_note ? `: “${detail.return_note}”` : ""}.${detail.email_status === "sent" ? ` It had been submitted to ${(detail.sent_to?.length ? detail.sent_to : (detail.recipients ?? [])).join(", ")} on ${fmt(detail.email_sent_at)}.` : ""}`
            })()}
          </p>
          {detail.status === "completed" && (
            <div className="flex flex-wrap gap-3 mb-4">
              {canMarkReviewed(detail) && (
                <button className="h-8 px-3 rounded-md border text-sm" disabled={off} onClick={() => act(detail.id, "review")}>Reviewed</button>
              )}
              {canSubmit(detail) && (
                <button className="h-8 px-3 rounded-md bg-gray-900 text-white text-sm disabled:opacity-60" disabled={off || !settings} onClick={() => startSubmit(detail.id)}>
                  {reviewState(detail) === "ready" ? "Submit to bank contact" : "Submit again"}
                </button>
              )}
              {canSendBack(detail) && (
                <button className="h-8 px-3 rounded-md border text-sm" disabled={off} onClick={() => startSendBack(detail.id, detail.form_data?.full_name || detail.label)}>Send back to client</button>
              )}
              {undoSendBackButton(detail, "h-8 px-3 rounded-md border text-sm")}
            </div>
          )}
          <table className="w-full text-sm mb-4">
            <tbody>
              {[...BOFA_TEXT_FIELDS, ...BOFA_SHIPPING_FIELDS].map((f) => (
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

      {submitFor && settings && (
        <Modal title="Submit to the bank contact?" onClose={() => setSubmitFor(null)}>
          <p className="text-sm mb-3">
            This emails the answers and all documents to <b className="break-all">{settings.submit_to.length ? settings.submit_to.join(", ") : "(no address is set)"}</b>. It cannot be taken back.
          </p>
          <dl className="text-sm space-y-1 mb-3">
            <div className="flex gap-2"><dt className="text-muted-foreground w-28 shrink-0">Applicant</dt><dd>{submitFor.form_data?.full_name || "—"}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground w-28 shrink-0">Company</dt><dd>{submitFor.form_data?.company_name || "—"}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground w-28 shrink-0">Documents</dt><dd>{submitFor.files.length} ({submitFor.files.map((f) => f.label).join(", ")})</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground w-28 shrink-0">Shipping address</dt><dd>{[submitFor.form_data?.shipping_street, [submitFor.form_data?.shipping_city, submitFor.form_data?.shipping_region, submitFor.form_data?.shipping_zip].filter(Boolean).join(" "), submitFor.form_data?.shipping_country].filter(Boolean).join(", ") || "not on this older application"}</dd></div>
          </dl>
          {sendMayHaveGoneOut(submitFor) && (
            <p className="text-sm text-red-700 mb-2">
              {isStaleSending(submitFor) ? "The last attempt never finished" : "The last attempt ended with an error that Gmail never confirmed"}, so the email may already have gone to the bank contact. Check the Sent mailbox before you submit again, or they may get it twice.
            </p>
          )}
          {settings.submit_to.length === 0 && <p className="text-sm text-red-700 mb-2">No address is set. Set it on the Forms page, in the Bank account application card.</p>}
          {dialogError && <p className="text-sm text-red-700 mb-2" role="alert">{dialogError}</p>}
          <div className="flex gap-2">
            <button className="h-9 px-4 rounded-md bg-gray-900 text-white text-sm disabled:opacity-60" disabled={busy || settings.submit_to.length === 0} onClick={confirmSubmit}>
              {busy ? "Submitting…" : "Submit now"}
            </button>
            <button className="h-9 px-4 rounded-md border text-sm" onClick={() => setSubmitFor(null)} disabled={busy}>Cancel</button>
          </div>
        </Modal>
      )}

      {sendBackFor && (
        <Modal title={`Send back to ${sendBackFor.who}`} onClose={() => setSendBackFor(null)}>
          {newLink ? (
            <>
              {newLink.linkOnly ? (
                <p className="text-sm text-green-800 mb-2">The new link is ready. <b>No email was sent.</b> Your message shows at the top of the form the client opens.</p>
              ) : (
                <p className="text-sm text-red-700 mb-2">The new link was made, but the email to the client could not be sent: {newLink.error}</p>
              )}
              <p className="text-sm mb-2">Copy this link and send it to the client yourself (WhatsApp or any other way):</p>
              <p className="break-all text-xs bg-gray-50 border rounded p-2 mb-2">{newLink.url}</p>
              <div className="flex gap-2">
                <button className="h-8 px-3 rounded-md border text-sm" onClick={() => copy(newLink.url)}>Copy link</button>
                <button className="h-8 px-3 rounded-md border text-sm" onClick={() => { setSendBackFor(null); setNewLink(null) }}>Close</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm mb-2">
                The client gets an email with a <b>new one-time link</b> and your message, and fills the form again with their documents. This application stays on record as sent back.
                To share the link yourself (WhatsApp or any other way), press <b>Create link only</b>: nothing is emailed.
              </p>
              <label className="text-sm font-medium block mb-1">What does the client need to fix? <span className="text-xs font-normal text-red-600">Required</span></label>
              <textarea className="w-full rounded-md border px-3 py-2 text-sm mb-2" rows={5} value={note} onChange={(e) => { setNote(e.target.value); setDialogError("") }} placeholder="Example: the passport photo is cut off on the right. Please upload a full-page photo." />
              {dialogError && <p className="text-sm text-red-700 mb-2" role="alert">{dialogError}</p>}
              <div className="flex gap-2">
                <button className="h-9 px-4 rounded-md bg-gray-900 text-white text-sm disabled:opacity-60" disabled={busy || !note.trim()} onClick={() => confirmSendBack(true)}>
                  {busy ? "Sending…" : "Send back and email the client"}
                </button>
                <button className="h-9 px-4 rounded-md border text-sm disabled:opacity-60" disabled={busy || !note.trim()} onClick={() => confirmSendBack(false)}>
                  Create link only
                </button>
                <button className="h-9 px-4 rounded-md border text-sm" onClick={() => setSendBackFor(null)} disabled={busy}>Cancel</button>
              </div>
            </>
          )}
        </Modal>
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
