/**
 * POST /api/tax-form-completed
 *
 * Called by the tax form frontend after the client submits.
 * 1. Sends email notification to support@
 * 2. Updates service delivery stage_history
 * 3. Creates review task for Antonio
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from("tax_return_submissions")
      .select("id, token, account_id, contact_id, tax_year, entity_type, status")
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

    // Get company name
    let companyName = token
    if (sub.account_id) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name")
        .eq("id", sub.account_id)
        .single()
      if (acc) companyName = acc.company_name
    }

    // ─── 1. EMAIL NOTIFICATION TO SUPPORT ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `Tax Form Completed: ${companyName} (${sub.tax_year})`
      const emailBody = [
        `The tax data collection form for ${companyName} has been submitted by the client.`,
        ``,
        `Tax Year: ${sub.tax_year}`,
        `Entity Type: ${sub.entity_type}`,
        `Token: ${sub.token}`,
        ``,
        `Next steps:`,
        `- Review submitted data: tax_form_review(token="${sub.token}")`,
        `- If data complete, apply changes and advance pipeline`,
        ``,
        `Admin Preview: ${APP_BASE_URL}/tax-form/${sub.token}?preview=td`,
      ].join("\n")

      const mimeHeaders = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: support@tonydurante.us`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: text/plain; charset=utf-8`,
        "Content-Transfer-Encoding: base64",
      ]
      const rawEmail = [...mimeHeaders, "", Buffer.from(emailBody).toString("base64")].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")

      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok", detail: `Notified support@ about ${companyName}` })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── 2. UPDATE SERVICE DELIVERY HISTORY ───
    if (sub.account_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_order, stage_history, service_type")
          .eq("account_id", sub.account_id)
          .eq("service_type", "Tax Return Filing")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "tax_form_submitted",
            at: new Date().toISOString(),
            note: `Tax form submitted by client for ${companyName} (${sub.tax_year})`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Tax Return Filing SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 3. CREATE REVIEW TASK FOR ANTONIO ───
      try {
        const taskTitle = `Review tax form data — ${companyName} (${sub.tax_year})`

        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", taskTitle)
          .eq("account_id", sub.account_id)
          .maybeSingle()

        if (!existingTask) {
          await supabaseAdmin.from("tasks").insert({
            task_title: taskTitle,
            description: [
              `Client ${companyName} has submitted tax data for ${sub.tax_year}.`,
              ``,
              `Entity type: ${sub.entity_type}`,
              `Review: tax_form_review(token="${sub.token}")`,
              `Action: Review data completeness, then apply_changes=true to update CRM.`,
            ].join("\n"),
            assigned_to: "Antonio",
            priority: "High",
            category: "Tax",
            status: "To Do",
            account_id: sub.account_id,
            created_by: "System",
          })
          results.push({ step: "review_task", status: "ok", detail: taskTitle })
        } else {
          results.push({ step: "review_task", status: "skipped", detail: "Already exists" })
        }
      } catch (e) {
        results.push({ step: "review_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 4. SAVE FORM DATA + UPLOADS TO DRIVE ───
    if (sub.account_id) {
      try {
        const { data: fullSub } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("submitted_data, upload_paths, completed_at")
          .eq("id", submission_id)
          .single()

        const { data: acc } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", sub.account_id)
          .single()

        if (fullSub?.submitted_data && acc?.drive_folder_id) {
          const { saveFormToDrive } = await import("@/lib/form-to-drive")
          const driveResult = await saveFormToDrive(
            "tax_return",
            fullSub.submitted_data as Record<string, unknown>,
            (fullSub.upload_paths as string[]) || [],
            acc.drive_folder_id,
            { token: sub.token, submittedAt: fullSub.completed_at || new Date().toISOString(), companyName, year: sub.tax_year }
          )
          if (driveResult.summaryFileId) {
            results.push({ step: "drive_save", status: "ok", detail: `Summary: ${driveResult.summaryFileId}, ${driveResult.copied.length} files copied` })
          }
          if (driveResult.errors.length > 0) {
            results.push({ step: "drive_save", status: "error", detail: driveResult.errors.join(", ") })
          }
        } else {
          results.push({ step: "drive_save", status: "skipped", detail: `No data or no drive_folder_id` })
        }
      } catch (e) {
        results.push({ step: "drive_save", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 5. AUTO-GENERATE P&L FOR MMLLCs ───
    if (sub.entity_type === "MMLLC" && sub.account_id) {
      try {
        // Wait for Drive save to complete (files need to be in Drive first)
        // Then trigger bank statement processing + P&L generation
        const { downloadFileBinary, listFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
        const { parseBankStatement, categorizeTransaction } = await import("@/lib/bank-statement-parser")

        const { data: acc } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id, company_name")
          .eq("id", sub.account_id)
          .single()

        if (acc?.drive_folder_id) {
          // Find Tax folder
          const listing = (await listFolder(acc.drive_folder_id)) as {
            files?: { id: string; name: string; mimeType: string }[]
          }
          const taxFolder = listing.files?.find(
            (f: { name: string; mimeType: string }) => f.mimeType === "application/vnd.google-apps.folder" && /^3\.\s*Tax/i.test(f.name)
          )

          if (taxFolder) {
            // List bank statement files in Tax folder
            const taxFiles = (await listFolder(taxFolder.id, 100)) as {
              files?: { id: string; name: string; mimeType: string }[]
            }
            const statementPattern = /wise|mercury|relay|statement|bank|estratto/i
            const statements = (taxFiles.files || []).filter((f: { name: string; mimeType: string }) => {
              const isStatement = statementPattern.test(f.name)
              const isSupported = f.mimeType === "application/pdf" || f.mimeType === "text/csv"
                || f.name.toLowerCase().endsWith(".csv") || f.name.toLowerCase().endsWith(".pdf")
              return isStatement && isSupported
            })

            if (statements.length > 0) {
              // Get member names for categorization
              const { data: links } = await supabaseAdmin
                .from("account_contacts")
                .select("contacts(first_name, last_name)")
                .eq("account_id", sub.account_id)
              const memberNames = ((links || []) as unknown as Array<{ contacts: { first_name: string; last_name: string } | null }>)
                .filter(l => l.contacts)
                .map(l => `${l.contacts!.first_name} ${l.contacts!.last_name}`.trim())

              let totalParsed = 0
              for (const file of statements) {
                try {
                  // Check if already processed
                  const { data: existing } = await supabaseAdmin
                    .from("bank_transactions")
                    .select("id")
                    .eq("source_file_id", file.id)
                    .limit(1)
                  if (existing && existing.length > 0) continue

                  const { buffer, mimeType } = await downloadFileBinary(file.id)
                  const result = await parseBankStatement(buffer, file.name, mimeType)

                  for (const tx of result.transactions) {
                    const txYear = parseInt(tx.transaction_date.substring(0, 4))
                    if (txYear !== sub.tax_year) continue

                    const cat = categorizeTransaction(tx, memberNames, [])
                    await supabaseAdmin
                      .from("bank_transactions")
                      .upsert({
                        account_id: sub.account_id,
                        tax_year: sub.tax_year,
                        transaction_date: cat.transaction_date,
                        description: cat.description,
                        category: cat.category,
                        subcategory: cat.subcategory,
                        counterparty: cat.counterparty,
                        amount: cat.amount,
                        currency: cat.currency,
                        balance_after: cat.balance_after,
                        bank_name: cat.bank_name,
                        account_type: cat.account_type,
                        transaction_ref: cat.transaction_ref,
                        source_file_id: file.id,
                        is_related_party: cat.is_related_party,
                        notes: cat.notes,
                      }, {
                        onConflict: "account_id,transaction_ref,transaction_date,amount",
                        ignoreDuplicates: true,
                      })
                    totalParsed++
                  }
                } catch (fileErr) {
                  // Skip individual file errors, continue with others
                }
              }

              results.push({
                step: "bank_statement_parse",
                status: totalParsed > 0 ? "ok" : "skipped",
                detail: `Parsed ${totalParsed} transactions from ${statements.length} bank statement files`,
              })

              // Generate P&L if we have transactions
              if (totalParsed > 0) {
                try {
                  // Trigger P&L generation via the MCP tool logic
                  // For now, just log that it's ready — the MCP tool can be called to generate Excel
                  results.push({
                    step: "pnl_ready",
                    status: "ok",
                    detail: `${totalParsed} transactions stored. Run bank_statement_pnl to generate Excel.`,
                  })
                } catch (pnlErr) {
                  results.push({
                    step: "pnl_generation",
                    status: "error",
                    detail: pnlErr instanceof Error ? pnlErr.message : String(pnlErr),
                  })
                }
              }
            } else {
              results.push({ step: "bank_statement_parse", status: "skipped", detail: "No bank statement files found in Tax folder" })
            }
          } else {
            results.push({ step: "bank_statement_parse", status: "skipped", detail: "No Tax folder found" })
          }
        }
      } catch (e) {
        results.push({ step: "bank_statement_parse", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[tax-form-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
