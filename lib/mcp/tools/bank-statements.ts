/**
 * Bank Statement Processing MCP Tools
 * Parse bank statements (CSV/PDF), categorize transactions, generate P&L + Balance Sheet.
 *
 * Tools:
 *   bank_statement_process     — Download + parse + categorize + store transactions
 *   bank_statement_pnl         — Generate P&L + Balance Sheet Excel, upload to Drive
 *   bank_statement_review      — List transactions grouped by category
 *   bank_statement_recategorize — Update a transaction's category
 *
 * IRS RULE: All US tax returns must be filed in USD. EUR/GBP amounts are
 * converted using the IRS yearly average exchange rate.
 * Source: https://www.irs.gov/individuals/international-taxpayers/yearly-average-currency-exchange-rates
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { downloadFileBinary, listFolder, uploadBinaryToDriveUpsert, findTaxFolder } from "@/lib/google-drive"
import { parseBankStatement, categorizeTransaction, type CategorizedTransaction } from "@/lib/bank-statement-parser"
import { logAction } from "@/lib/mcp/action-log"

// ─── Helpers ────────────────────────────────────────────────

/** Get member names and related entities for an account */
async function getAccountContext(accountId: string) {
  // Get account info
  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("company_name, drive_folder_id")
    .eq("id", accountId)
    .single()

  // The SHARED roster — curated members ∪ linked contacts, with the one
  // usable-name rule. This tool used to build its own list from the contact
  // links alone with no rule at all, which made staff processing disagree with
  // the portal ingest and the periodic re-sort: the same rows flipped category
  // depending on which path last ran. See lib/tax/member-roster.ts.
  const { fetchMemberRoster } = await import("@/lib/tax/member-roster")
  const memberNames = (await fetchMemberRoster(supabaseAdmin, accountId)).names

  return {
    companyName: account?.company_name || "Unknown",
    driveFolderId: account?.drive_folder_id || "",
    memberNames,
    relatedEntities: [] as string[], // Can be populated from a future config table
  }
}

// findTaxFolder imported from @/lib/google-drive (shared helper)

/** Get IRS exchange rate for a currency/year */
async function getIrsRate(currency: string, taxYear: number): Promise<number | null> {
  if (currency === "USD") return 1

  const { data } = await supabaseAdmin
    .from("irs_exchange_rates")
    .select("rate_to_usd")
    .eq("tax_year", taxYear)
    .eq("currency", currency)
    .single()

  return data?.rate_to_usd || null
}

// ─── Tool Registration ──────────────────────────────────────

export function registerBankStatementTools(server: McpServer) {

  // ═══════════════════════════════════════
  // bank_statement_process
  // ═══════════════════════════════════════
  server.tool(
    "bank_statement_process",
    "Download bank statement PDFs/CSVs from a client's Drive '3. Tax' folder, parse all transactions, auto-categorize (income/expense/distribution/fee/conversion), and store in bank_transactions table. Idempotent: skips files already processed unless reprocess=true. Returns summary with transaction counts and totals. CSV files are preferred over PDFs for accuracy. Prerequisite: client must have bank statements uploaded to their Drive folder.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      reprocess: z.boolean().optional().default(false).describe("Re-parse already processed files (default: false)"),
      file_id: z.string().optional().describe("Process a specific Drive file ID instead of scanning the folder"),
    },
    async ({ account_id, tax_year, reprocess, file_id }) => {
      try {
        const ctx = await getAccountContext(account_id)
        if (!ctx.driveFolderId && !file_id) {
          return { content: [{ type: "text" as const, text: "❌ Account has no Drive folder linked. Set drive_folder_id first." }] }
        }

        // Find files to process
        let filesToProcess: { id: string; name: string; mimeType: string }[] = []

        if (file_id) {
          // Process specific file
          const { mimeType, fileName } = await downloadFileBinary(file_id)
          filesToProcess = [{ id: file_id, name: fileName, mimeType }]
        } else {
          // Find Tax folder
          const taxFolderId = await findTaxFolder(ctx.driveFolderId)
          if (!taxFolderId) {
            return { content: [{ type: "text" as const, text: "❌ No '3. Tax' folder found in client's Drive folder." }] }
          }

          // Prefer the year subfolder (where the portal auto-chain saves statements,
          // e.g. '3. Tax/2025/'); fall back to the Tax root for legacy uploads.
          let scanFolderId = taxFolderId
          const taxContents = (await listFolder(taxFolderId, 100)) as {
            files?: { id: string; name: string; mimeType: string }[]
          }
          const yearFolder = taxContents.files?.find(f =>
            f.mimeType === "application/vnd.google-apps.folder" && f.name === String(tax_year)
          )
          if (yearFolder) scanFolderId = yearFolder.id

          const listing = (await listFolder(scanFolderId, 100)) as {
            files?: { id: string; name: string; mimeType: string }[]
          }

          // Filter for bank statement files (incl. .zip archives of monthly statements)
          const statementPattern = /wise|mercury|relay|chase|statement|bank|estratto/i
          filesToProcess = (listing.files || []).filter(f => {
            const lower = f.name.toLowerCase()
            const isStatement = statementPattern.test(f.name)
            const isSupported = f.mimeType === "application/pdf"
              || f.mimeType === "text/csv"
              || lower.endsWith(".csv")
              || lower.endsWith(".pdf")
              || lower.endsWith(".zip")
            return isStatement && isSupported
          })
        }

        if (filesToProcess.length === 0) {
          return { content: [{ type: "text" as const, text: "No bank statement files found in Tax folder. Upload CSV or PDF statements first." }] }
        }

        // Check which files are already processed — PAGINATED (card 4a39e0fd):
        // this select returned max 1000 TRANSACTION rows, so with more rows
        // across the checked files a processed file's id could miss the set →
        // the file re-parsed → AI-extracted PDFs could DUPLICATE (the exact
        // cross-parse class behind Dynamiq's 2,138 extra rows).
        if (!reprocess) {
          const { fetchAllPaged } = await import("@/lib/bank-transactions-fetch")
          const existing = await fetchAllPaged<{ source_file_id: string | null }>(async (from, to) => {
            const { data: page, error } = await supabaseAdmin
              .from("bank_transactions")
              .select("source_file_id")
              .eq("account_id", account_id)
              .in("source_file_id", filesToProcess.map(f => f.id))
              .order("id", { ascending: true })
              .range(from, to)
            if (error) throw new Error(error.message)
            return (page ?? []) as { source_file_id: string | null }[]
          })

          const processedIds = new Set((existing || []).map(e => e.source_file_id))
          const before = filesToProcess.length
          filesToProcess = filesToProcess.filter(f => !processedIds.has(f.id))

          if (filesToProcess.length === 0) {
            return { content: [{ type: "text" as const, text: `All ${before} statement files already processed. Use reprocess=true to re-parse.` }] }
          }
        }

        // Process each file
        let totalTransactions = 0
        let totalIncome = 0
        let totalExpenses = 0
        let uncategorizedCount = 0
        const fileResults: string[] = []
        const allErrors: string[] = []

        for (const file of filesToProcess) {
          try {
            // If reprocessing, delete old transactions for this file
            if (reprocess) {
              await supabaseAdmin
                .from("bank_transactions")
                .delete()
                .eq("source_file_id", file.id)
                .eq("account_id", account_id)
            }

            // Download and parse
            const { buffer, mimeType } = await downloadFileBinary(file.id)
            const result = await parseBankStatement(buffer, file.name, mimeType)

            if (result.errors.length > 0) {
              allErrors.push(`${file.name}: ${result.errors.join("; ")}`)
            }

            if (result.transactions.length === 0) {
              fileResults.push(`${file.name}: 0 transactions (${result.errors.length} errors)`)
              continue
            }

            // Categorize and insert
            const categorized: CategorizedTransaction[] = result.transactions.map(tx =>
              categorizeTransaction(tx, ctx.memberNames, ctx.relatedEntities)
            )

            // Filter to tax year
            const yearFiltered = categorized.filter(tx => {
              const txYear = parseInt(tx.transaction_date.substring(0, 4))
              return txYear === tax_year
            })

            // Insert into bank_transactions
            for (const tx of yearFiltered) {
              const { error } = await supabaseAdmin
                .from("bank_transactions")
                .upsert({
                  account_id,
                  tax_year,
                  transaction_date: tx.transaction_date,
                  description: tx.description,
                  category: tx.category,
                  subcategory: tx.subcategory,
                  counterparty: tx.counterparty,
                  amount: tx.amount,
                  currency: tx.currency,
                  balance_after: tx.balance_after,
                  bank_name: tx.bank_name,
                  account_type: tx.account_type,
                  transaction_ref: tx.transaction_ref,
                  source_file_id: file.id,
                  is_related_party: tx.is_related_party,
                  notes: tx.notes,
                }, {
                  onConflict: "account_id,transaction_ref,transaction_date,amount",
                  ignoreDuplicates: true,
                })

              if (error) {
                allErrors.push(`Insert error: ${error.message}`)
              }
            }

            // Tally
            for (const tx of yearFiltered) {
              totalTransactions++
              if (tx.category === "income") totalIncome += tx.amount
              if (["cogs", "expense", "fee", "refund"].includes(tx.category)) totalExpenses += Math.abs(tx.amount)
              if (tx.category === "uncategorized") uncategorizedCount++
            }

            fileResults.push(`${file.name}: ${yearFiltered.length} transactions (${result.currency})`)
          } catch (err: any) {
            allErrors.push(`${file.name}: ${err.message}`)
            fileResults.push(`${file.name}: FAILED — ${err.message}`)
          }
        }

        // Post-ingest categorization pass: DB rules (global + per-client) +
        // transfer-pair matching across the WHOLE account-year set — internal
        // moves between the client's own banks must never count as revenue or
        // expense (master plan §4). Re-runnable; manual corrections preserved.
        let recatNote = ""
        try {
          const { recategorizeAccountYear } = await import("@/lib/tax/categorization-engine")
          const recat = await recategorizeAccountYear(account_id, tax_year, { aiAssist: true })
          uncategorizedCount = recat.uncategorizedRemaining
          if (recat.handsOffSkipped) {
            recatNote = `⛔ Categorization pass SKIPPED — the client has already confirmed this account's ${tax_year} return. Re-sorting a confirmed return needs staff to reopen it first, not this tool.`
          } else {
            recatNote = `Categorization pass: ${recat.recategorized} updated (${recat.aiCategorized} by AI, tagged ai:high), ${recat.transferPairs} transfer pairs excluded from P&L`
            if (recat.aiErrors.length > 0) recatNote += ` — AI assist notes: ${recat.aiErrors.join("; ")}`
          }
        } catch (e) {
          recatNote = `⚠️ Categorization pass failed (transactions ingested fine): ${e instanceof Error ? e.message : String(e)}`
        }

        // Log action
        logAction({
          action_type: "bank_statement_process",
          table_name: "bank_transactions",
          record_id: account_id,
          summary: `Processed ${filesToProcess.length} files for ${ctx.companyName}: ${totalTransactions} transactions`,
          details: { files: fileResults, errors: allErrors, recategorization: recatNote },
        })

        const summary = [
          `✅ Bank statements processed for ${ctx.companyName}`,
          "",
          `Files: ${filesToProcess.length}`,
          ...fileResults.map(r => `  • ${r}`),
          "",
          `Total transactions: ${totalTransactions}`,
          `Income: ${totalIncome.toFixed(2)}`,
          `Expenses: ${totalExpenses.toFixed(2)}`,
          recatNote,
          uncategorizedCount > 0 ? `⚠️ Uncategorized: ${uncategorizedCount} (use bank_statement_review to check)` : "",
          allErrors.length > 0 ? `\nErrors:\n${allErrors.map(e => `  ⚠️ ${e}`).join("\n")}` : "",
        ].filter(Boolean).join("\n")

        return { content: [{ type: "text" as const, text: summary }] }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // bank_statement_pnl
  // ═══════════════════════════════════════
  server.tool(
    "bank_statement_pnl",
    "Generate Profit & Loss statement + Balance Sheet from parsed bank transactions. Outputs Excel with dual currency (original + USD at IRS rate). Uploads to client's Drive '3. Tax' folder. IRS RULE: All US tax returns must be in USD — the tool automatically converts using the IRS yearly average exchange rate. Includes K-1 allocation per member based on ownership %. Prerequisite: run bank_statement_process first.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      upload_to_drive: z.boolean().optional().default(true).describe("Upload Excel to Drive (default: true)"),
    },
    async ({ account_id, tax_year, upload_to_drive }) => {
      try {
        const ctx = await getAccountContext(account_id)

        // Get transactions — PAGINATED (card 4a39e0fd): the unpaginated
        // select capped at 1000 rows, so on big accounts every summary stat
        // below (uncategorized count, year-end cash, distributions by member,
        // primary currency) covered only the first 1000 rows by date — it
        // reported Dynamiq at "470 uncategorized" when the truth was 3,189,
        // and its "year-end cash" was EARLY-year cash. The workbook itself was
        // always correct (engine uses this same paginated fetch).
        const { fetchAllBankTransactionsByYear } = await import("@/lib/bank-transactions-fetch")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transactions = await fetchAllBankTransactionsByYear<any>(
          account_id, tax_year, "*", { column: "transaction_date", ascending: true },
        )

        if (!transactions || transactions.length === 0) {
          return { content: [{ type: "text" as const, text: "No transactions found. Run bank_statement_process first." }] }
        }

        // Get IRS rate
        const currencies = Array.from(new Set(transactions.map(t => t.currency)))
        const rates: Record<string, number> = {}
        for (const curr of currencies) {
          const rate = await getIrsRate(curr, tax_year)
          if (rate) rates[curr] = rate
          else rates[curr] = 1 // Fallback to 1:1
        }

        // Category groupings used by the text summary below (the workbook's own
        // groupings live in the shared engine now).
        const cogs = transactions.filter(t => t.category === "cogs")
        const distributions = transactions.filter(t => t.category === "distribution")
        const uncategorized = transactions.filter(t => t.category === "uncategorized")

        // Totals + the workbook now BOTH come from the ONE financials engine
        // (getFinancialsView), so this tool reports and files exactly the same
        // numbers as the client's portal screen and the accountant hand-off —
        // corrected beginning balances, refund-netted expenses, and the FX
        // translation adjustment included.
        const { getFinancialsView } = await import("@/lib/tax/financials-orchestration")
        const engineView = await getFinancialsView(account_id, tax_year)
        const {
          totalIncome, totalCogs, grossProfit, totalExpenses, netIncome, totalDistributions,
        } = engineView.draft.pnl

        // Get primary currency (most transactions)
        const currencyCounts = transactions.reduce((acc, t) => {
          acc[t.currency] = (acc[t.currency] || 0) + 1
          return acc
        }, {} as Record<string, number>)
        const primaryCurrency = Object.entries(currencyCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || "USD"
        const irsRate = rates[primaryCurrency]

        // Year-end balances per currency account
        const accountBalances: Record<string, number> = {}
        for (const tx of transactions) {
          const key = `${tx.bank_name} ${tx.account_type}`
          if (tx.balance_after !== null) {
            accountBalances[key] = Number(tx.balance_after)
          }
        }

        // distByMember — the year's distributions grouped by member. Kept here
        // because the text summary below reports it; the workbook itself is built
        // by the ONE shared engine, not in this file.
        const distByMember: Record<string, number> = {}
        for (const t of distributions) {
          const name = t.counterparty || "Unknown"
          distByMember[name] = (distByMember[name] || 0) + Math.abs(Number(t.amount))
        }

        // ── SINGLE ENGINE ── build the 5-sheet P&L / Balance Sheet workbook from
        // the financials engine draft (buildFinancialsWorkbookForAccount) — the
        // SAME artifact the client downloads and the accountant hand-off archives.
        // This tool previously used the legacy transaction-based generator, which
        // had drifted from the engine (raw last balance for assets, no name-drift
        // identity healing, single-rate multi-currency). One engine, one file.
        const { buildFinancialsWorkbookForAccount } = await import("@/lib/tax/financials-orchestration")
        const built = await buildFinancialsWorkbookForAccount(account_id, tax_year)
        if (!built) throw new Error("No transactions available to build the P&L for this account and year")
        const { buffer, fileName } = built

        // Upload to Drive
        let driveLink = ""
        if (upload_to_drive && ctx.driveFolderId) {
          const taxFolderId = await findTaxFolder(ctx.driveFolderId)
          const targetFolder = taxFolderId || ctx.driveFolderId

          // Stable name -> UPSERT: re-run refreshes the one existing file in place (LT Program incident class).
          const uploaded = (await uploadBinaryToDriveUpsert(
            fileName, buffer,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            targetFolder,
          )) as { id: string; name: string }

          driveLink = `https://drive.google.com/file/d/${uploaded.id}/view`

          logAction({
            action_type: "bank_statement_pnl",
            table_name: "bank_transactions",
            record_id: account_id,
            summary: `Generated P&L for ${ctx.companyName} (${tax_year}), uploaded to Drive`,
            details: { drive_file_id: uploaded.id, net_income: netIncome },
          })
        }

        // Summary — ALL figures below (totalIncome/totalCogs/grossProfit/
        // totalExpenses/netIncome/totalDistributions/member income_share) come
        // straight from engineView.draft, which financials-engine.ts already
        // converts to USD before computing a single total (every bank
        // currency merged into one). There is no separate "native total" left
        // to show once that merge happens, so — unlike a per-row amount —
        // these must NEVER be re-wrapped in the local toUSD() or labeled with
        // primaryCurrency: that combination silently divided an already-USD
        // figure a second time, showing a wrong, inflated dollar amount under
        // a currency label that was never accurate for a merged total either
        // (fixed 2026-08-19; verified the filed Excel was never affected —
        // financials-excel.ts prints draft.pnl.netIncome directly, with no
        // such wrapper, and applies its own toUSD only to fresh raw per-row
        // amounts for the detail sheet, which is a genuine first conversion).
        const rateNote = primaryCurrency !== "USD"
          ? `\nIRS ${tax_year} rate: 1 ${primaryCurrency} / ${irsRate} = USD (per-transaction currencies below the summary are still native)`
          : ""

        const summary = [
          `✅ P&L generated for ${ctx.companyName} (${tax_year})`,
          rateNote,
          "",
          `Revenue: $${totalIncome.toFixed(2)}`,
          cogs.length > 0 ? `COGS: $${totalCogs.toFixed(2)}` : "",
          `Gross Profit: $${grossProfit.toFixed(2)}`,
          `Operating Expenses: $${totalExpenses.toFixed(2)}`,
          `Net Income: $${netIncome.toFixed(2)}`,
          "",
          "K-1 Allocation:",
          // Same members + percentages as the filed workbook (engineView.draft
          // .members) — this used to be a second, independently-scraped list
          // built straight from account_contacts with no null-guard and no
          // role filter, which is how a duplicate/orphan contact link once
          // produced a literal "null null" phantom member here (WSCP LLC,
          // 2026-08-18). Reusing the engine's own resolved list — including
          // its own already-computed income_share, not a second hand-rolled
          // copy of the same formula — means this text can never again
          // disagree with the numbers it's describing.
          ...engineView.draft.members.map(m => `  ${m.name} (${m.pct}%): $${m.income_share.toFixed(2)}`),
          // A member can be on file with NO resolved ownership % (real cases
          // exist today — see lib/tax/ownership-resolution.ts) — the engine
          // correctly excludes them from the allocation above rather than
          // guessing, but silence would mean they simply vanish from this
          // summary with no trace. Name them instead.
          ...engineView.ownership.missing.map(name => `  ⚠ ${name}: ownership % missing — not included above`),
          "",
          `Distributions: $${totalDistributions.toFixed(2)}`,
          // Per-member breakdown below is grouped by raw bank counterparty text
          // (not the resolved roster), so the same person spelled differently
          // across statements can appear as two lines — pre-existing, flagged
          // separately, not this fix's scope.
          ...Object.entries(distByMember).map(([name, amt]) => `  ${name}: ${primaryCurrency} ${amt.toFixed(2)} (native, unconverted)`),
          "",
          `Year-end cash: ${Object.entries(accountBalances).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(", ") || "N/A"}`,
          uncategorized.length > 0 ? `\n⚠️ ${uncategorized.length} uncategorized transactions — review before sending to India` : "",
          driveLink ? `\n📎 Excel: ${driveLink}` : "",
          "",
          "5 sheets: P&L Statement, Balance Sheet, Income Detail, Expense Detail, Distributions",
        ].filter(Boolean).join("\n")

        return { content: [{ type: "text" as const, text: summary }] }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // bank_statement_review
  // ═══════════════════════════════════════
  server.tool(
    "bank_statement_review",
    "List parsed bank transactions grouped by category with running totals. Use to review categorization before generating P&L. Highlights uncategorized transactions that need manual review. Filter by category to focus on specific types.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      category: z.string().optional().describe("Filter by category: income, cogs, expense, distribution, contribution, fee, conversion, refund, uncategorized"),
    },
    async ({ account_id, tax_year, category }) => {
      try {
        // PAGINATED (card 4a39e0fd): the unpaginated select capped at 1000
        // rows — on big accounts the listing AND the per-category totals were
        // silently computed on a truncated set.
        const { fetchAllPaged } = await import("@/lib/bank-transactions-fetch")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await fetchAllPaged<any>(async (from, to) => {
          let q = supabaseAdmin
            .from("bank_transactions")
            .select("*")
            .eq("account_id", account_id)
            .eq("tax_year", tax_year)
            .order("transaction_date", { ascending: true })
            .order("id", { ascending: true })
          if (category) q = q.eq("category", category)
          const { data: page, error } = await q.range(from, to)
          if (error) throw new Error(error.message)
          return page ?? []
        })
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No transactions found." }] }
        }

        // Group by category
        const grouped: Record<string, typeof data> = {}
        for (const tx of data) {
          const cat = tx.category || "uncategorized"
          if (!grouped[cat]) grouped[cat] = []
          grouped[cat].push(tx)
        }

        const lines: string[] = [`Bank Transactions: ${data.length} total\n`]

        for (const [cat, txs] of Object.entries(grouped)) {
          const total = txs.reduce((s, t) => s + Number(t.amount), 0)
          const icon = cat === "uncategorized" ? "⚠️" : "📋"
          lines.push(`${icon} ${cat.toUpperCase()} (${txs.length} transactions, total: ${total.toFixed(2)})`)

          for (const tx of txs) {
            const rp = tx.is_related_party ? " [RP]" : ""
            lines.push(`  ${tx.transaction_date} | ${tx.counterparty || "—"} | ${Number(tx.amount).toFixed(2)} ${tx.currency} | ${tx.subcategory || "—"}${rp}`)
            if (tx.description && tx.description.length > 0) {
              lines.push(`    ${tx.description.substring(0, 80)}`)
            }
          }
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // bank_statement_recategorize
  // ═══════════════════════════════════════
  server.tool(
    "bank_statement_recategorize",
    "Update the category and/or subcategory of a bank transaction. Use after bank_statement_review to fix uncategorized or miscategorized transactions before generating P&L.",
    {
      transaction_id: z.string().uuid().describe("Transaction UUID from bank_statement_review"),
      category: z.enum(["income", "cogs", "expense", "distribution", "contribution", "fee", "conversion", "refund", "uncategorized"]).describe("New category ('contribution' = owner capital in — equity, never P&L revenue)"),
      subcategory: z.string().optional().describe("New subcategory (e.g., 'coaching_revenue', 'subcontractor', 'bank_fee')"),
      is_related_party: z.boolean().optional().describe("Mark as related party transaction"),
    },
    async ({ transaction_id, category, subcategory, is_related_party }) => {
      try {
        const updates: Record<string, any> = { category }
        if (subcategory !== undefined) updates.subcategory = subcategory
        if (is_related_party !== undefined) updates.is_related_party = is_related_party
        // "manual:" marks a human correction — recategorizeAccountYear (rules +
        // transfer + AI passes) will never overwrite a row carrying this marker.
        updates.notes = `manual: ${category}${subcategory ? `/${subcategory}` : ""} via recategorize tool`

        const { data, error } = await supabaseAdmin
          .from("bank_transactions")
          .update(updates)
          .eq("id", transaction_id)
          .select("transaction_date, description, amount, currency, category, subcategory")
          .single()

        if (error) throw new Error(error.message)

        logAction({
          action_type: "bank_statement_recategorize",
          table_name: "bank_transactions",
          record_id: transaction_id,
          summary: `Recategorized to ${category}/${subcategory || "—"}`,
          details: updates,
        })

        return { content: [{ type: "text" as const, text: `✅ Updated: ${data.transaction_date} | ${data.description?.substring(0, 50)} | ${data.amount} ${data.currency} → ${category}/${subcategory || "—"}` }] }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err.message}` }] }
      }
    }
  )
}
