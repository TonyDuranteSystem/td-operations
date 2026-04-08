/**
 * CRON: Universal Deadline Reminder System
 *
 * Runs daily. Checks ALL upcoming deadlines and creates tasks/emails
 * 30 days before each deadline.
 *
 * Deadline types checked:
 * - Delaware Franchise Tax (Corps+MMLLC: Mar 1, SM LLCs: Jun 1)
 * - Tax Return deadlines (MMLLC: Mar 15, SMLLC/Corp: Apr 15)
 * - Extended deadlines (MMLLC: Sep 15, SMLLC/Corp: Oct 15)
 * - ITIN renewal (Jun 15, every 3 years from itin_issue_date)
 * - CMRA renewal (cmra_renewal_date on accounts)
 *
 * RA Renewal and Annual Report have their own crons already.
 *
 * Schedule: Daily via Vercel Cron
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

interface _DeadlineCheck {
  type: string
  description: string
  deadline: string // YYYY-MM-DD
  reminderDaysBefore: number
  query: () => Promise<Array<{ id: string; name: string; detail?: string }>>
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()
  const today = now.toISOString().split("T")[0]
  const year = now.getFullYear()
  const results: Array<{ type: string; action: string; count: number }> = []

  // Helper: check if date is within N days from now
  const isWithinDays = (dateStr: string, days: number): boolean => {
    const target = new Date(dateStr)
    const diff = (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    return diff > 0 && diff <= days
  }

  // Helper: create task if not exists
  const createTaskIfNew = async (title: string, description: string, priority: string, dueDate: string, accountId?: string) => {
    const { data: existing } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .eq("task_title", title)
      .limit(1)
    if (existing?.length) return false

    await supabaseAdmin.from("tasks").insert({
      task_title: title,
      description,
      assigned_to: "Luca",
      priority,
      category: "Filing",
      status: "To Do",
      due_date: dueDate,
      account_id: accountId || null,
      created_by: "System",
    })
    return true
  }

  try {
    // ═══════════════════════════════════════
    // 1. DELAWARE FRANCHISE TAX
    // ═══════════════════════════════════════
    // Corps + MMLLC: deadline Mar 1 → reminder 30d before (Jan 29)
    // SM LLCs: deadline Jun 1 → reminder 30d before (May 1)

    const deCorpDeadline = `${year}-03-01`
    const deLlcDeadline = `${year}-06-01`

    if (isWithinDays(deCorpDeadline, 30)) {
      const { data: deCorps } = await supabaseAdmin
        .from("accounts")
        .select("id, company_name, entity_type")
        .eq("status", "Active")
        .ilike("state_of_formation", "%Delaware%")
        .or("entity_type.ilike.%Corp%,entity_type.ilike.%Multi%,entity_type.ilike.%MMLLC%")
        .or("is_test.is.null,is_test.eq.false")

      if (deCorps?.length) {
        let created = 0
        for (const acct of deCorps) {
          const made = await createTaskIfNew(
            `[DE TAX] Franchise Tax ${year} -- ${acct.company_name}`,
            `Delaware Franchise Tax due March 1, ${year}.\nEntity: ${acct.entity_type}\nLLC flat fee: $300. Corporation: calculated per authorized shares.\nFile on Delaware Division of Corporations portal.`,
            "High",
            `${year}-02-15`,
            acct.id,
          )
          if (made) created++
        }
        results.push({ type: "DE Franchise Tax (Corp/MMLLC)", action: "checked", count: created })
      }
    }

    if (isWithinDays(deLlcDeadline, 30)) {
      const { data: deLlcs } = await supabaseAdmin
        .from("accounts")
        .select("id, company_name, entity_type")
        .eq("status", "Active")
        .ilike("state_of_formation", "%Delaware%")
        .or("entity_type.ilike.%Single%,entity_type.ilike.%SMLLC%")
        .or("is_test.is.null,is_test.eq.false")

      if (deLlcs?.length) {
        let created = 0
        for (const acct of deLlcs) {
          const made = await createTaskIfNew(
            `[DE TAX] Franchise Tax ${year} -- ${acct.company_name}`,
            `Delaware Franchise Tax due June 1, ${year}.\nEntity: ${acct.entity_type} (Single Member LLC)\nFlat fee: $300.\nFile on Delaware Division of Corporations portal.`,
            "High",
            `${year}-05-15`,
            acct.id,
          )
          if (made) created++
        }
        results.push({ type: "DE Franchise Tax (SM LLC)", action: "checked", count: created })
      }
    }

    // ═══════════════════════════════════════
    // 2. TAX RETURN DEADLINES
    // ═══════════════════════════════════════

    const taxDeadlines = [
      { type: "MMLLC", deadline: `${year}-03-15`, reminderBy: `${year}-02-13`, returnTypes: ["MMLLC"] },
      { type: "SMLLC/Corp", deadline: `${year}-04-15`, reminderBy: `${year}-03-16`, returnTypes: ["SMLLC", "Corp"] },
      { type: "MMLLC Extended", deadline: `${year}-09-15`, reminderBy: `${year}-08-16`, returnTypes: ["MMLLC"] },
      { type: "SMLLC/Corp Extended", deadline: `${year}-10-15`, reminderBy: `${year}-09-15`, returnTypes: ["SMLLC", "Corp"] },
    ]

    for (const td of taxDeadlines) {
      if (isWithinDays(td.deadline, 30)) {
        // Check for unfiled returns approaching deadline
        const { data: unfiled } = await supabaseAdmin
          .from("tax_returns")
          .select("id, account_id, return_type, status, extension_filed")
          .eq("tax_year", year - 1) // Filing for previous year
          .in("return_type", td.returnTypes)
          .not("status", "eq", "TR Filed")

        if (unfiled?.length) {
          const isExtended = td.type.includes("Extended")
          const atRisk = isExtended
            ? unfiled.filter(r => r.extension_filed) // Extended deadline only matters if extension was filed
            : unfiled.filter(r => !r.extension_filed) // Original deadline matters if NO extension

          if (atRisk.length > 0) {
            // Get company names
            const accountIds = atRisk.filter(r => r.account_id).map(r => r.account_id!)
            const { data: accounts } = await supabaseAdmin
              .from("accounts")
              .select("id, company_name")
              .in("id", accountIds)
            const nameMap = new Map((accounts || []).map(a => [a.id, a.company_name]))

            const made = await createTaskIfNew(
              `[TAX DEADLINE] ${td.type} -- ${year - 1} returns due ${td.deadline}`,
              `${atRisk.length} tax returns approaching ${td.type} deadline (${td.deadline}):\n${atRisk.map(r => `- ${nameMap.get(r.account_id!) || r.account_id} (${r.status})`).join("\n")}\n\nAction: ${isExtended ? "These have extensions. Must file before deadline." : "File extension IMMEDIATELY if not already done."}`,
              "Urgent",
              td.reminderBy,
            )
            results.push({ type: `Tax ${td.type}`, action: made ? "task_created" : "exists", count: atRisk.length })
          }
        }
      }
    }

    // ═══════════════════════════════════════
    // 3. ITIN RENEWAL (every 3 years)
    // ═══════════════════════════════════════
    const itinDeadline = `${year}-06-15`
    if (isWithinDays(itinDeadline, 30)) {
      const threeYearsAgo = `${year - 3}-01-01`
      const { data: itinContacts } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name, itin_number, itin_issue_date")
        .not("itin_number", "is", null)
        .lte("itin_issue_date", threeYearsAgo)
        .or("is_test.is.null,is_test.eq.false")

      if (itinContacts?.length) {
        let created = 0
        for (const c of itinContacts) {
          const made = await createTaskIfNew(
            `[ITIN RENEWAL] ${c.full_name} -- ITIN ${c.itin_number}`,
            `ITIN renewal recommended. Issued: ${c.itin_issue_date}.\nITIN numbers expire if not used on a tax return for 3 consecutive years.\nDeadline: June 15, ${year}.\nContact client to initiate renewal process.`,
            "Normal",
            `${year}-05-15`,
          )
          if (made) created++
        }
        results.push({ type: "ITIN Renewal", action: "checked", count: created })
      }
    }

    // ═══════════════════════════════════════
    // 4. CMRA RENEWAL (Dec 31 expiry)
    // ═══════════════════════════════════════
    const { data: cmraAccounts } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, cmra_renewal_date")
      .eq("status", "Active")
      .not("cmra_renewal_date", "is", null)
      .or("is_test.is.null,is_test.eq.false")

    if (cmraAccounts?.length) {
      let created = 0
      for (const acct of cmraAccounts) {
        if (acct.cmra_renewal_date && isWithinDays(acct.cmra_renewal_date, 30)) {
          const made = await createTaskIfNew(
            `[CMRA] Lease renewal ${year + 1} -- ${acct.company_name}`,
            `CMRA lease expires ${acct.cmra_renewal_date}.\nNew lease for ${year + 1} will be created after 1st installment payment.\nNo action needed now — tracked for awareness.`,
            "Normal",
            acct.cmra_renewal_date,
            acct.id,
          )
          if (made) created++
        }
      }
      if (created > 0) results.push({ type: "CMRA Renewal", action: "checked", count: created })
    }

    // Log
    await supabaseAdmin.from("action_log").insert({
      action_type: "deadline_reminders_cron",
      entity_type: "system",
      summary: `Deadline check: ${results.map(r => `${r.type}(${r.count})`).join(", ") || "nothing due"}`,
      details: { date: today, results },
    })

    logCron({ endpoint: "/api/cron/deadline-reminders", status: "success", duration_ms: Date.now() - startTime, details: { date: today, results } })

    return NextResponse.json({ ok: true, date: today, results })
  } catch (err) {
    console.error("[deadline-reminders]", err)
    logCron({ endpoint: "/api/cron/deadline-reminders", status: "error", duration_ms: Date.now() - startTime, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
