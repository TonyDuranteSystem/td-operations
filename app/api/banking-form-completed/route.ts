/**
 * POST /api/banking-form-completed
 *
 * Called by the banking form frontend after the client submits.
 * 1. Sends email notification to support@
 * 2. Creates follow-up task based on provider (Relay vs Payset)
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from("banking_submissions")
      .select("id, token, provider, account_id, contact_id, status, prefilled_data")
      .eq("id", submission_id)
      .eq("token", token)
      .single()

    if (subErr || !sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 })
    }

    if (sub.status !== "completed") {
      return NextResponse.json({ error: "Form not completed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []
    const prefilled = (sub.prefilled_data || {}) as Record<string, string>
    const companyName = prefilled.business_name || token
    const providerName = sub.provider === "relay" ? "Relay (USD)" : "Payset (EUR)"

    // ─── 1. EMAIL NOTIFICATION TO SUPPORT ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `Banking Form Completed: ${companyName} — ${providerName}`
      const emailBody = [
        `The ${providerName} banking form for ${companyName} has been submitted by the client.`,
        ``,
        `Provider: ${sub.provider}`,
        `Token: ${sub.token}`,
        ``,
        `Next steps:`,
        sub.provider === "relay"
          ? `- Review data and submit Relay application`
          : `- Schedule live Payset application session (WhatsApp/Telegram)`,
        ``,
        `Review: banking_form_review(token="${sub.token}")`,
      ].join("\n")

      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const mimeHeaders = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: support@tonydurante.us`,
        `Subject: ${encodedSubject}`,
        "MIME-Version: 1.0",
        `Content-Type: text/plain; charset=utf-8`,
        "Content-Transfer-Encoding: base64",
      ]
      const rawEmail = [...mimeHeaders, "", Buffer.from(emailBody).toString("base64")].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")

      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok", detail: `Notified support@ about ${providerName}` })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── 2. CREATE FOLLOW-UP TASK ───
    if (sub.account_id) {
      try {
        const taskTitle = sub.provider === "relay"
          ? `Submit Relay USD application — ${companyName}`
          : `Schedule Payset application session — ${companyName}`

        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", taskTitle)
          .eq("account_id", sub.account_id)
          .maybeSingle()

        if (!existingTask) {
          const description = sub.provider === "relay"
            ? [
                `Client submitted Relay banking form data.`,
                ``,
                `Review: banking_form_review(token="${sub.token}")`,
                `Action: Submit application via Relay dashboard.`,
              ].join("\n")
            : [
                `Client submitted Payset banking form data.`,
                ``,
                `Review: banking_form_review(token="${sub.token}")`,
                `Action: Schedule live session for OTP verification and application completion.`,
              ].join("\n")

          await supabaseAdmin.from("tasks").insert({
            task_title: taskTitle,
            description,
            assigned_to: "Luca",
            priority: "High",
            category: "Banking",
            status: "To Do",
            account_id: sub.account_id,
            created_by: "System",
          })
          results.push({ step: "task_created", status: "ok", detail: taskTitle })
        } else {
          results.push({ step: "task_created", status: "skipped", detail: "Already exists" })
        }
      } catch (e) {
        results.push({ step: "task_created", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[banking-form-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
