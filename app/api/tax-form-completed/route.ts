/**
 * POST /api/tax-form-completed
 *
 * Called by the tax form frontend after the client submits.
 * Auto-chain per Tax Return SOP:
 *
 * 1. Update contact (only changed fields)
 * 2. Check passport for one-time customers
 * 3. Send detailed email to team (support@)
 * 4. Update tax_returns status -> Data Received
 * 5. Advance SD -> Data Received
 * 6. Save complete data PDF + uploads to Drive (3. Tax/{year}/)
 * 7. Auto P&L for MMLLC (parse bank statements)
 * 8. Create task for team
 * 9. Update SD history
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

// Added 2026-04-14 P0.7: protect the 9-step auto-chain from mid-execution
// Vercel timeout (CRM update + passport check + email + tax_returns advance +
// SD advance + Drive save + P&L parse + task + history).
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { advanceStageIfAt } from "@/lib/operations/service-delivery"
import { APP_BASE_URL } from "@/lib/config"
import { listFolder, uploadBinaryToDrive, downloadFileBinary } from "@/lib/google-drive"

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

    // ─── 0A. UPDATE CONTACT (only changed fields) ───
    if (sub.contact_id) {
      try {
        const { data: fullSub0 } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("submitted_data")
          .eq("id", submission_id)
          .single()
        const sd0 = (fullSub0?.submitted_data || {}) as Record<string, unknown>

        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("phone, residency, citizenship")
          .eq("id", sub.contact_id)
          .single()

        if (contact) {
          const updates: Record<string, unknown> = {}
          if (sd0.owner_phone && sd0.owner_phone !== contact.phone) updates.phone = sd0.owner_phone
          if (sd0.owner_tax_residency && sd0.owner_tax_residency !== contact.citizenship) updates.citizenship = sd0.owner_tax_residency

          const newAddr = [sd0.owner_street, sd0.owner_city, sd0.owner_state_province, sd0.owner_zip, sd0.owner_country].filter(Boolean).join(", ")
          if (newAddr && newAddr !== contact.residency) updates.residency = newAddr

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString()
            await dbWrite(
              supabaseAdmin.from("contacts").update(updates).eq("id", sub.contact_id),
              "contacts.update"
            )
            results.push({ step: "contact_update", status: "ok", detail: `Updated: ${Object.keys(updates).filter(k => k !== "updated_at").join(", ")}` })
          } else {
            results.push({ step: "contact_update", status: "skipped", detail: "No changes detected" })
          }
        }
      } catch (e) {
        results.push({ step: "contact_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 0B. CHECK PASSPORT FOR ONE-TIME CUSTOMERS ───
    if (sub.account_id) {
      try {
        const { data: acc0 } = await supabaseAdmin
          .from("accounts")
          .select("account_type")
          .eq("id", sub.account_id)
          .single()

        if (acc0?.account_type === "One-Time" && sub.contact_id) {
          const { data: contact0 } = await supabaseAdmin
            .from("contacts")
            .select("passport_on_file")
            .eq("id", sub.contact_id)
            .single()

          if (contact0 && !contact0.passport_on_file) {
            const { data: contactInfo } = await supabaseAdmin
              .from("contacts")
              .select("full_name, email")
              .eq("id", sub.contact_id)
              .single()

            await dbWriteSafe(
              supabaseAdmin.from("tasks").insert({
                task_title: `[MISSING] Request passport from ${contactInfo?.full_name || "client"} (${companyName})`,
                description: `One-time client ${companyName} submitted tax form but has NO passport on file.\nEmail ${contactInfo?.email || "client"} to request a clear passport scan.\nPassport is required for tax return filing.`,
                assigned_to: "Luca",
                priority: "Urgent",
                category: "Document",
                status: "To Do",
                due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
                account_id: sub.account_id,
                contact_id: sub.contact_id,
                created_by: "System",
              }),
              "tasks.insert"
            )
            results.push({ step: "passport_check", status: "missing", detail: "One-time client, no passport on file. Urgent task created." })
          } else {
            results.push({ step: "passport_check", status: "ok", detail: "Passport on file" })
          }
        } else {
          results.push({ step: "passport_check", status: "skipped", detail: "Annual client (passport already on file)" })
        }
      } catch (e) {
        results.push({ step: "passport_check", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 1. DETAILED EMAIL TO TEAM ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const { data: fullSubEmail } = await supabaseAdmin
        .from("tax_return_submissions")
        .select("submitted_data, upload_paths")
        .eq("id", submission_id)
        .single()

      const sd = (fullSubEmail?.submitted_data || {}) as Record<string, unknown>
      const uploads = (fullSubEmail?.upload_paths || []) as string[]

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] Tax Form Completed - ${companyName} (${sub.tax_year})</h2>
<p>Client <strong>${companyName}</strong> has submitted the tax data collection form for ${sub.tax_year}.</p>

<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Entity type:</td><td style="padding:4px 8px">${sub.entity_type}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Revenue reported:</td><td style="padding:4px 8px">${sd.total_revenue || sd.gross_revenue || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Expenses reported:</td><td style="padding:4px 8px">${sd.total_expenses || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Bank accounts used:</td><td style="padding:4px 8px">${sd.bank_accounts_used || sd.banks_used || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Documents uploaded:</td><td style="padding:4px 8px">${uploads.length} files</td></tr>
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps (per Tax Return SOP v4.0)</h3>
<ol>
<li>Review data: <code>tax_form_review(token="${sub.token}")</code></li>
<li>If complete, apply changes: <code>tax_form_review(token="${sub.token}", apply_changes=true)</code></li>
${(sub.entity_type === "MMLLC" || sub.entity_type === "Corp") ? `<li>Bank statements auto-parsed. Review: <code>bank_statement_review(account_id="${sub.account_id}")</code></li>
<li>Generate P&L: <code>bank_statement_pnl(account_id="${sub.account_id}", tax_year=${sub.tax_year})</code></li>` : ""}
<li>Check if 2nd installment is paid (Stage 6 gate)</li>
<li>When ready, send to accountant: <code>tax_send_to_accountant(account_id="${sub.account_id}", tax_year=${sub.tax_year})</code></li>
</ol>

<p style="font-size:12px;color:#6b7280">Token: ${sub.token} | Admin: ${APP_BASE_URL}/tax-form/${sub.token}?preview=td</p>
</div>`

      const taxSubject = `[TASK] Tax Form Completed - ${companyName} (${sub.tax_year})`
      const encodedSubject = `=?utf-8?B?${Buffer.from(taxSubject).toString("base64")}?=`
      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Subject: ${encodedSubject}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      results.push({ step: "email_notification", status: "ok", detail: `Detailed email sent to support@ (team)` })
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
          .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
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

          await dbWriteSafe(
            supabaseAdmin
              .from("service_deliveries")
              .update({ stage_history: history })
              .eq("id", sd.id),
            "service_deliveries.update"
          )

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Tax Return Filing SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 3. CREATE REVIEW TASK FOR TEAM ───
      try {
        const taskTitle = `Review tax form data -- ${companyName} (${sub.tax_year})`

        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", taskTitle)
          .eq("account_id", sub.account_id)
          .maybeSingle()

        if (!existingTask) {
          await dbWriteSafe(
            supabaseAdmin.from("tasks").insert({
              task_title: taskTitle,
              description: [
                `Client ${companyName} has submitted tax data for ${sub.tax_year}.`,
                ``,
                `Entity type: ${sub.entity_type}`,
                `Review: tax_form_review(token="${sub.token}")`,
                `Action: Review data completeness, then apply_changes=true to update CRM.`,
              ].join("\n"),
              assigned_to: "Luca",
              priority: "High",
              category: "Tax" as never,
              status: "To Do",
              account_id: sub.account_id,
              created_by: "System",
            }),
            "tasks.insert"
          )
          results.push({ step: "review_task", status: "ok", detail: taskTitle })
        } else {
          results.push({ step: "review_task", status: "skipped", detail: "Already exists" })
        }
      } catch (e) {
        results.push({ step: "review_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 4. UPDATE tax_returns STATUS ───
    if (sub.account_id) {
      try {
        const { data: tr } = await supabaseAdmin
          .from("tax_returns")
          .select("id, status")
          .eq("account_id", sub.account_id)
          .eq("tax_year", sub.tax_year)
          .maybeSingle()

        if (tr) {
          await dbWrite(
            supabaseAdmin
              .from("tax_returns")
              .update({
                data_received: true,
                data_received_date: new Date().toISOString().split("T")[0],
                status: "Data Received",
                updated_at: new Date().toISOString(),
              })
              .eq("id", tr.id),
            "tax_returns.update"
          )
          results.push({ step: "tax_return_status", status: "ok", detail: `tax_returns ${tr.id} -> Data Received` })
        } else {
          results.push({ step: "tax_return_status", status: "skipped", detail: "No tax_returns record found" })
        }
      } catch (e) {
        results.push({ step: "tax_return_status", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 4B. ADVANCE SD to "Data Received" ───
    // Uses P1.6 operation layer (advanceStageIfAt). Gate matches legacy
    // stages "Data Link Sent"/"Activated" that live on existing SD rows
    // even though they aren't in the current Tax Return pipeline — the
    // gate check is permissive (string match), the target validation is
    // strict (must be a real pipeline_stages row). skip_tasks=true
    // because tax_form review task is created manually in STEP 3 above.
    if (sub.account_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id")
          .eq("account_id", sub.account_id)
          .eq("service_type", "Tax Return")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const advanceResult = await advanceStageIfAt({
            delivery_id: sd.id,
            if_current_stage: ["Data Link Sent", "Activated"],
            target_stage: "Data Received",
            actor: "tax-form-completed",
            notes: `Tax form submitted by client (${sub.tax_year})`,
            skip_tasks: true,
          })
          if (advanceResult.advanced) {
            results.push({ step: "sd_advance", status: "ok", detail: `SD ${sd.id} -> Data Received` })
          } else if (advanceResult.current_stage && ["Data Link Sent", "Activated"].includes(advanceResult.current_stage)) {
            results.push({ step: "sd_advance", status: "error", detail: advanceResult.result?.error || advanceResult.reason })
          }
          // Otherwise skipped silently (gate not met) — matches prior behavior
        }
      } catch (e) {
        results.push({ step: "sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 5. SAVE FORM DATA + UPLOADS TO DRIVE ───
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

    // ─── 5. AUTO-GENERATE P&L FOR MMLLCs + Corps ───
    if ((sub.entity_type === "MMLLC" || sub.entity_type === "Corp") && sub.account_id) {
      try {
        // Wait for Drive save to complete (files need to be in Drive first)
        // Then trigger bank statement processing + P&L generation
        // downloadFileBinary, listFolder, uploadBinaryToDrive imported at top
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
                    await dbWriteSafe(
                      supabaseAdmin
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
                        }),
                      "bank_transactions.upsert"
                    )
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
                  // Auto-generate P&L Excel and upload to Drive
                  const { generatePnlExcel } = await import("@/lib/pnl-generator")
                  const pnl = await generatePnlExcel(sub.account_id!, sub.tax_year)

                  // Upload to Drive Tax/{year}/ folder
                  const { data: accDrive } = await supabaseAdmin
                    .from("accounts")
                    .select("drive_folder_id")
                    .eq("id", sub.account_id!)
                    .single()

                  if (accDrive?.drive_folder_id) {
                    const taxFolderId = await (async () => {
                      const lf = await listFolder(accDrive.drive_folder_id)
                      const files = (lf as { files?: { id: string; name: string; mimeType: string }[] }).files || []
                      const tf = files.find(f => f.mimeType === "application/vnd.google-apps.folder" && /^3\.\s*Tax/i.test(f.name))
                      if (!tf) return accDrive.drive_folder_id
                      // Find year subfolder
                      const yearLf = await listFolder(tf.id)
                      const yearFiles = (yearLf as { files?: { id: string; name: string; mimeType: string }[] }).files || []
                      const yf = yearFiles.find(f => f.name === String(sub.tax_year) && f.mimeType === "application/vnd.google-apps.folder")
                      return yf?.id || tf.id
                    })()

                    await uploadBinaryToDrive(
                      pnl.fileName,
                      pnl.buffer,
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      taxFolderId,
                    )
                  }

                  results.push({
                    step: "pnl_generated",
                    status: "ok",
                    detail: `P&L Excel generated and uploaded to Drive. ${pnl.summary}`,
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
