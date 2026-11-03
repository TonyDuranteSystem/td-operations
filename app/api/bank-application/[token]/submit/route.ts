/**
 * POST /api/bank-application/[token]/submit — records the finished application and kills the link.
 *
 * Owner-only. Body: { data, files: [{ key, name, path }] }. Everything is validated server-side
 * with the same schema the page uses; each file must really exist in the bucket under THIS link's
 * own token. The final UPDATE only succeeds while the row is still 'opened', so a double-click or a
 * replay cannot submit twice. The submit STORES the application, files it in CRM Storage and tells our own people
 * (link only, no answers in the email). Nothing is forwarded to any outside party: staff mark it Reviewed and press
 * Submit on the staff page (lib/bofa-intake/deliver.ts) — Antonio 2026-11-02. This route deliberately touches only
 * the long-standing columns, so a client's submission can never break while a database step is still pending.
 */

export const maxDuration = 120
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gateLink } from "@/lib/bofa-intake/access"
import { BOFA_BUCKET, validateSubmission } from "@/lib/bofa-intake/schema"
import { CRM_BASE_URL } from "@/lib/config"
import { archiveSubmission } from "@/lib/bofa-intake/archive"
import { withShippingAddress } from "@/lib/bofa-intake/shipping"
import { loadBofaSettings } from "@/lib/bofa-intake/settings"
import { sendHtmlEmail } from "@/lib/bofa-intake/notify"
import { escapeHtml } from "@/lib/bofa-intake/email"

type Params = { params: Promise<{ token: string }> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

async function fileExists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/")
  const dir = path.slice(0, slash)
  const name = path.slice(slash + 1)
  const { data, error } = await supabaseAdmin.storage.from(BOFA_BUCKET).list(dir, { search: name, limit: 5 })
  if (error || !data) return false
  return data.some((o) => o.name === name)
}

/** Is this the client's corrected answer to an application staff sent back? Tolerant: a hiccup just means the ordinary notice. */
async function isResubmission(id: string): Promise<boolean> {
  try {
    const { data, error } = await table().select("replaces_id").eq("id", id).maybeSingle()
    return !error && !!data?.replaces_id
  } catch {
    return false
  }
}

async function notifyStaff(label: string, companyName: string, id: string, resubmitted: boolean): Promise<boolean> {
  try {
    const settings = await loadBofaSettings()
    const subject = resubmitted ? `Bank application RESUBMITTED: ${label}` : `Bank application to review: ${label}`
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1e3a5f;">${resubmitted ? "A bank application was corrected and resubmitted" : "A bank application is waiting for your review"}</h2>
      <p>${resubmitted ? "The client corrected the application you sent back" : "The one-time application link"} <strong>${escapeHtml(label)}</strong> ${resubmitted ? "and submitted it again" : "was submitted"} (company: <strong>${escapeHtml(companyName)}</strong>).</p>
      <p>Review the answers and documents, then press <b>Reviewed</b> and <b>Submit</b>: <a href="${CRM_BASE_URL}/bofa-intake?open=${id}">${CRM_BASE_URL}/bofa-intake</a></p>
      <p style="color:#666;font-size:12px;">Nothing has been sent to anyone outside Tony Durante LLC yet.</p></div>`
    await sendHtmlEmail({ to: settings.notifyTo, subject, html })
    return true
  } catch (e) {
    console.error("[bank-application] staff notification failed:", e)
    return false
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  const gate = await gateLink(req, token, false)
  if ("reason" in gate) {
    if (gate.reason === "error") return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 503 })
    return NextResponse.json({ error: "This link is no longer active." }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const result = validateSubmission(body.data, body.files, token)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })

  for (const f of result.files) {
    if (!(await fileExists(f.path))) {
      return NextResponse.json({ error: `The file for "${f.name}" did not finish uploading. Please upload it again.` }, { status: 400 })
    }
  }

  const { data: updated, error } = await table()
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      // the shipping address is OUR office, written by the server: nothing the browser sends can change it
      form_data: withShippingAddress(result.data),
      files: result.files,
      updated_at: new Date().toISOString(),
    })
    .eq("id", gate.row.id)
    .eq("status", "opened")
    .select("id, label")
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Could not save your application. Please try again." }, { status: 500 })
  if (!updated) {
    const { data: now } = await table().select("status").eq("id", gate.row.id).maybeSingle()
    const message = now?.status === "revoked"
      ? "This link was cancelled. Ask Tony Durante LLC for a new one."
      : "This application was already submitted."
    return NextResponse.json({ error: message }, { status: 409 })
  }

  const sent = await notifyStaff(updated.label, result.data.company_name, updated.id, await isResubmission(updated.id))
  if (sent) await table().update({ notified_at: new Date().toISOString() }).eq("id", updated.id)

  // The application is safely stored. File it in CRM Storage (Business › BofA). A failure never fails the client's
  // submission — it is recorded on the row and staff can press "Save to Storage". It is NOT emailed onward here.
  try {
    await archiveSubmission(updated.id)
  } catch (e) {
    console.error("[bank-application] archive crashed:", e)
  }

  const res = NextResponse.json({ ok: true })
  res.headers.set("Cache-Control", "no-store")
  return res
}
