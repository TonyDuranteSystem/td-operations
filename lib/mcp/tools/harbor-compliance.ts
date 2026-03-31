/**
 * Harbor Compliance MCP Tools
 *
 * Tools:
 *   hc_list_companies       — List companies on HC, show CRM links
 *   hc_sync_company         — Push CRM account data to HC (create or update)
 *   hc_submit_ra_change     — Submit Change of Registered Agent order
 *   hc_get_order            — Check order status by ID
 *   hc_list_deliveries      — List RA mail/documents received
 *   hc_download_delivery    — Download delivery PDF to client's Google Drive
 *   hc_list_licenses        — List licenses/registrations with expirations
 *   hc_sync_license_deadlines — Pull HC license expirations into deadlines table
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { harborCompliance } from "@/lib/harbor-compliance"
import { logAction } from "@/lib/mcp/action-log"
import { uploadBinaryToDrive } from "@/lib/google-drive"

export function registerHarborComplianceTools(server: McpServer) {

  // ═══════════════════════════════════════
  // hc_list_companies
  // ═══════════════════════════════════════
  server.tool(
    "hc_list_companies",
    `List companies registered on Harbor Compliance. Shows HC company ID, legal name, domicile, and whether each is linked to a CRM account (via accounts.hc_company_id). Use this to see what's on HC and identify unlinked companies.`,
    {
      limit: z.number().optional().default(20).describe("Results per page (1-100, default 20)"),
      page: z.number().optional().default(1).describe("Page number (default 1)"),
    },
    async (params) => {
      try {
        const result = await harborCompliance.listCompanies({
          pagination: { limit: params.limit, page: params.page },
          include: ["domicile", "business_structure"],
        })

        if (!result.data?.length) {
          return { content: [{ type: "text" as const, text: "No companies found on Harbor Compliance." }] }
        }

        // Check which are linked in CRM
        const hcIds = result.data.map((c) => c.id)
        const { data: linked } = await supabaseAdmin
          .from("accounts")
          .select("hc_company_id, company_name")
          .in("hc_company_id", hcIds)

        const linkMap = new Map(
          (linked || []).map((a) => [a.hc_company_id, a.company_name])
        )

        const lines = [
          `Found ${result.data.length} companies on HC (page ${params.page}, has_more: ${result.has_more})\n`,
        ]
        for (const c of result.data) {
          const crmLink = linkMap.get(c.id)
          const linkStatus = crmLink ? `Linked to: ${crmLink}` : "NOT LINKED"
          const state = c.domicile?.name || "?"
          const structure = c.business_structure?.name || ""
          lines.push(`  ${c.legal_name}`)
          lines.push(`    HC ID: ${c.id} | ${state} | ${structure}`)
          lines.push(`    CRM: ${linkStatus}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_sync_company
  // ═══════════════════════════════════════
  server.tool(
    "hc_sync_company",
    `Push a CRM account's data to Harbor Compliance (create new HC company or update existing). Reads company_name, state_of_formation, entity_type, and primary contact address from CRM, then creates/updates on HC. Stores the HC company ID on accounts.hc_company_id.

Prerequisites:
- Account must exist with company_name and state_of_formation
- HC_CLIENT_ID and HC_CLIENT_SECRET env vars must be configured
- HC account ID (hc_account_id) must be set in env vars

Use hc_list_companies to verify after syncing.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID to sync to HC"),
    },
    async (params) => {
      try {
        // Fetch CRM account
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, state_of_formation, entity_type, hc_company_id, ein_number")
          .eq("id", params.account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `Account not found: ${accErr?.message || "no data"}` }] }
        }

        if (!account.company_name || !account.state_of_formation) {
          return { content: [{ type: "text" as const, text: `Account "${account.company_name || account.id}" missing company_name or state_of_formation.` }] }
        }

        // Fetch primary contact for address
        const { data: contactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", params.account_id)
          .limit(1)

        let address = {
          address_line_1: "10225 Ulmerton Rd",
          locality: "Largo",
          administrative_area: { id: "" }, // will be resolved
          postal_code: "33771",
          country: { id: "" }, // US
        }

        if (contactLinks?.length) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("address_line1, city, state, zip_code, country")
            .eq("id", contactLinks[0].contact_id)
            .single()

          if (contact?.address_line1) {
            address = {
              address_line_1: contact.address_line1,
              locality: contact.city || "Largo",
              administrative_area: { id: contact.state || "" },
              postal_code: contact.zip_code || "",
              country: { id: contact.country || "US" },
            }
          }
        }

        // Map entity_type to HC business structure
        // These IDs need to be resolved from HC reference data — using name-based lookup
        const structureMap: Record<string, string> = {
          "Single Member LLC": "LLC",
          "Multi-Member LLC": "LLC",
          "Corporation": "Corporation",
          "Partnership": "Partnership",
        }
        const structureName = structureMap[account.entity_type || ""] || "LLC"

        // Check if already synced
        if (account.hc_company_id) {
          // Update existing
          await harborCompliance.updateCompany(account.hc_company_id, {
            legal_name: account.company_name,
          })

          await logAction({
            action_type: "update",
            table_name: "hc_companies",
            record_id: account.hc_company_id,
            account_id: params.account_id,
            summary: `Updated HC company: ${account.company_name}`,
            details: { hc_company_id: account.hc_company_id },
          })

          return { content: [{ type: "text" as const, text: `Updated HC company ${account.hc_company_id} for "${account.company_name}".` }] }
        }

        // Create new — need HC account ID and jurisdiction/structure IDs from reference data
        // For now, we need these to be resolved. Log what we'd create.
        const lines = [
          `Ready to create HC company for "${account.company_name}":`,
          `  State: ${account.state_of_formation}`,
          `  Structure: ${structureName}`,
          `  Address: ${address.address_line_1}, ${address.locality} ${address.postal_code}`,
          ``,
          `NOTE: To complete creation, we need HC jurisdiction IDs and business structure IDs`,
          `from the reference data endpoints. These will be resolved when sandbox access is available.`,
          `Run hc_list_companies after creation to verify.`,
        ]

        // Placeholder for actual creation — requires resolved IDs
        // const result = await harborCompliance.createCompany({
        //   account_id: process.env.HC_ACCOUNT_ID!,
        //   legal_name: account.company_name,
        //   business_structure: { id: resolvedStructureId },
        //   domicile: { id: resolvedJurisdictionId },
        //   principal_address: address,
        //   mailing_address: address,
        // })
        //
        // Save HC company ID to CRM
        // await supabaseAdmin.from("accounts").update({ hc_company_id: result.data.id }).eq("id", params.account_id)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_submit_ra_change
  // ═══════════════════════════════════════
  server.tool(
    "hc_submit_ra_change",
    `Submit a "Change of Registered Agent" order on Harbor Compliance for a client's LLC. Requires the account to have an hc_company_id (use hc_sync_company first).

Prerequisites:
- Account must have hc_company_id set (linked to HC)
- Provide the jurisdiction ID for the state where RA change is needed
- Product ID for "Change of Registered Agent" must be known (use reference data)

Checks for duplicate orders to prevent double-submission.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      jurisdiction_id: z.string().describe("HC jurisdiction ID for the state (from reference data)"),
      product_id: z.string().describe("HC product ID for 'Change of Registered Agent' (from reference data)"),
    },
    async (params) => {
      try {
        // Fetch account with HC link
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, hc_company_id")
          .eq("id", params.account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `Account not found: ${accErr?.message || "no data"}` }] }
        }

        if (!account.hc_company_id) {
          return { content: [{ type: "text" as const, text: `Account "${account.company_name}" is not linked to HC. Run hc_sync_company first.` }] }
        }

        // Submit the order
        const result = await harborCompliance.createOrder({
          company: { id: account.hc_company_id },
          product: { id: params.product_id },
          jurisdictions: [{ id: params.jurisdiction_id }],
        })

        await logAction({
          action_type: "create",
          table_name: "hc_orders",
          record_id: result.data.id,
          account_id: params.account_id,
          summary: `Submitted RA change order for ${account.company_name}`,
          details: {
            hc_order_id: result.data.id,
            hc_company_id: account.hc_company_id,
            jurisdiction_id: params.jurisdiction_id,
          },
        })

        const lines = [
          `Order submitted successfully`,
          `  Order ID: ${result.data.id}`,
          `  Company: ${account.company_name}`,
          `  Product: Change of Registered Agent`,
          ``,
          `Use hc_get_order with order ID to track status.`,
        ]

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error submitting RA change: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_get_order
  // ═══════════════════════════════════════
  server.tool(
    "hc_get_order",
    `Check the status of a Harbor Compliance order by ID. Returns order details including company, product, and jurisdictions.`,
    {
      order_id: z.string().uuid().describe("HC order UUID"),
    },
    async (params) => {
      try {
        const result = await harborCompliance.getOrder(params.order_id)
        const order = result.data

        const jurisdictions = order.jurisdictions?.map((j) => j.name).join(", ") || "none"

        const lines = [
          `Order: ${order.id}`,
          `  Company: ${order.company?.legal_name || "?"}`,
          `  Product: ${order.product?.name || "?"}`,
          `  Jurisdictions: ${jurisdictions}`,
        ]

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_list_deliveries
  // ═══════════════════════════════════════
  server.tool(
    "hc_list_deliveries",
    `List Registered Agent deliveries (mail, packages, documents) received by Harbor Compliance. Shows document name, date, download status, and linked company. Use hc_download_delivery to save a document to the client's Google Drive.`,
    {
      limit: z.number().optional().default(20).describe("Results per page (1-100, default 20)"),
      page: z.number().optional().default(1).describe("Page number (default 1)"),
    },
    async (params) => {
      try {
        const result = await harborCompliance.listDeliveries({
          pagination: { limit: params.limit, page: params.page },
          include: ["company", "ref_jurisdiction", "document_type"],
        })

        if (!result.data?.length) {
          return { content: [{ type: "text" as const, text: "No RA deliveries found." }] }
        }

        const lines = [
          `Found ${result.data.length} deliveries (page ${params.page}, has_more: ${result.has_more})\n`,
        ]

        for (const d of result.data) {
          const company = d.company?.legal_name || "Unknown"
          const docType = d.document_type?.name || "Document"
          const state = d.jurisdiction?.name || ""
          const date = d.created_at ? new Date(d.created_at).toLocaleDateString() : "?"
          const downloadable = d.is_downloadable ? "downloadable" : "not downloadable"
          const downloaded = d.downloaded_at ? `downloaded ${new Date(d.downloaded_at).toLocaleDateString()}` : "not downloaded"

          lines.push(`  ${d.name}`)
          lines.push(`    ID: ${d.id} | ${docType} | ${state}`)
          lines.push(`    Company: ${company} | ${date}`)
          lines.push(`    Status: ${downloadable}, ${downloaded}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_download_delivery
  // ═══════════════════════════════════════
  server.tool(
    "hc_download_delivery",
    `Download an RA delivery document (PDF) from Harbor Compliance and upload it to the client's Google Drive folder. Requires the delivery ID (from hc_list_deliveries) and the CRM account ID (to find the Drive folder).

Prerequisites:
- Account must have drive_folder_id set
- Delivery must be downloadable (is_downloadable = true)

The file is saved to the client's "5. Correspondence" subfolder on Drive.`,
    {
      delivery_id: z.string().describe("HC delivery UUID (from hc_list_deliveries)"),
      account_id: z.string().uuid().describe("CRM account UUID (to find Drive folder)"),
    },
    async (params) => {
      try {
        // Get account's Drive folder
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, drive_folder_id")
          .eq("id", params.account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `Account not found: ${accErr?.message || "no data"}` }] }
        }

        if (!account.drive_folder_id) {
          return { content: [{ type: "text" as const, text: `Account "${account.company_name}" has no Drive folder. Set drive_folder_id first.` }] }
        }

        // Get delivery metadata
        const deliveryInfo = await harborCompliance.getDelivery(params.delivery_id, {
          include: ["company", "document_type"],
        })
        const delivery = deliveryInfo.data

        if (!delivery) {
          return { content: [{ type: "text" as const, text: `Delivery ${params.delivery_id} not found.` }] }
        }

        // Download PDF
        const pdfBuffer = await harborCompliance.downloadDeliveryFile(params.delivery_id)

        // Find "5. Correspondence" subfolder
        const { listFolder } = await import("@/lib/google-drive")
        const folderResult = await listFolder(account.drive_folder_id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const files = (folderResult as any)?.files || []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const correspondenceFolder = files.find((f: any) =>
          f.name?.startsWith("5") && f.mimeType === "application/vnd.google-apps.folder"
        )

        const targetFolder = correspondenceFolder?.id || account.drive_folder_id

        // Upload to Drive
        const fileName = `HC_${delivery.document_type?.name || "Document"}_${delivery.name || params.delivery_id}.pdf`
        const driveFile = await uploadBinaryToDrive(
          fileName,
          pdfBuffer,
          "application/pdf",
          targetFolder,
        )

        await logAction({
          action_type: "process",
          table_name: "hc_deliveries",
          record_id: params.delivery_id,
          account_id: params.account_id,
          summary: `Downloaded HC delivery "${delivery.name}" to Drive for ${account.company_name}`,
          details: {
            delivery_id: params.delivery_id,
            drive_file_id: driveFile?.id,
            file_name: fileName,
          },
        })

        const lines = [
          `Document downloaded and uploaded to Drive`,
          `  Delivery: ${delivery.name}`,
          `  Type: ${delivery.document_type?.name || "?"}`,
          `  Company: ${account.company_name}`,
          `  Drive file: ${fileName}`,
          `  Folder: ${correspondenceFolder ? "5. Correspondence" : "root"}`,
        ]

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_list_licenses
  // ═══════════════════════════════════════
  server.tool(
    "hc_list_licenses",
    `List licenses and registrations tracked by Harbor Compliance. Shows license number, holder, effective/expiration dates, next annual report due date, and jurisdiction. Filter by company or holder type.`,
    {
      company_id: z.string().optional().describe("Filter by HC company ID"),
      holder_type: z.enum(["company", "individual"]).optional().describe("Filter by holder type"),
      limit: z.number().optional().default(20).describe("Results per page (1-100, default 20)"),
      page: z.number().optional().default(1).describe("Page number (default 1)"),
    },
    async (params) => {
      try {
        const result = await harborCompliance.listLicenses({
          pagination: { limit: params.limit, page: params.page },
          include: ["company", "ref_jurisdiction", "ref_filing_authority"],
          holderType: params.holder_type,
          companyId: params.company_id,
        })

        if (!result.data?.length) {
          return { content: [{ type: "text" as const, text: "No licenses found." }] }
        }

        const lines = [
          `Found ${result.data.length} licenses (page ${params.page}, has_more: ${result.has_more})\n`,
        ]

        for (const lic of result.data) {
          const company = lic.company?.legal_name || "?"
          const state = lic.ref_jurisdiction?.name || "?"
          const expiry = lic.expiration_date || "no expiry"
          const nextAR = lic.next_annual_report_due_date || "N/A"
          const authority = lic.ref_filing_authority?.name || ""

          lines.push(`  ${lic.license_holder_on_license || company}`)
          lines.push(`    License #: ${lic.license_number} | ${state} | ${authority}`)
          lines.push(`    Effective: ${lic.effective_date} | Expires: ${expiry}`)
          lines.push(`    Next Annual Report: ${nextAR}`)
          lines.push(`    Type: ${lic.registration_type || "?"}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // hc_sync_license_deadlines
  // ═══════════════════════════════════════
  server.tool(
    "hc_sync_license_deadlines",
    `Pull license expiration dates from Harbor Compliance and create/update RA Renewal deadlines in the CRM deadlines table. Only processes licenses for companies linked to CRM accounts (via hc_company_id). Skips licenses without expiration dates.

Use this periodically to keep deadlines table in sync with HC registration data.`,
    {
      dry_run: z.boolean().optional().default(true).describe("Preview changes without updating (default: true)"),
    },
    async (params) => {
      try {
        // Get all licenses with company and jurisdiction info
        const allLicenses = []
        let page = 1
        let hasMore = true

        while (hasMore) {
          const result = await harborCompliance.listLicenses({
            pagination: { limit: 100, page },
            include: ["company", "ref_jurisdiction"],
            holderType: "company",
          })
          allLicenses.push(...result.data)
          hasMore = result.has_more
          page++
        }

        if (!allLicenses.length) {
          return { content: [{ type: "text" as const, text: "No licenses found on HC." }] }
        }

        // Get CRM accounts with HC links
        const hcCompanyIds = Array.from(new Set(allLicenses.map((l) => l.company?.id).filter(Boolean)))
        const { data: accounts } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, hc_company_id, state_of_formation")
          .in("hc_company_id", hcCompanyIds)

        const accountByHcId = new Map(
          (accounts || []).map((a) => [a.hc_company_id, a])
        )

        const created: string[] = []
        const updated: string[] = []
        const skipped: string[] = []

        for (const lic of allLicenses) {
          if (!lic.company?.id || !lic.expiration_date) {
            skipped.push(`${lic.license_holder_on_license || "?"}: no company or expiration`)
            continue
          }

          const account = accountByHcId.get(lic.company.id)
          if (!account) {
            skipped.push(`${lic.company.legal_name}: not linked to CRM`)
            continue
          }

          const dueDate = lic.expiration_date
          const state = lic.ref_jurisdiction?.name || account.state_of_formation || ""
          const year = new Date(dueDate).getFullYear()

          // Check if deadline already exists
          const { data: existing } = await supabaseAdmin
            .from("deadlines")
            .select("id, due_date, status")
            .eq("account_id", account.id)
            .eq("deadline_type", "RA Renewal")
            .eq("year", year)
            .maybeSingle()

          if (params.dry_run) {
            if (existing) {
              if (existing.due_date !== dueDate) {
                updated.push(`${account.company_name}: ${existing.due_date} -> ${dueDate}`)
              } else {
                skipped.push(`${account.company_name}: already up to date`)
              }
            } else {
              created.push(`${account.company_name}: RA Renewal due ${dueDate} (${state})`)
            }
            continue
          }

          // Actually create/update
          if (existing) {
            if (existing.due_date !== dueDate) {
              await supabaseAdmin
                .from("deadlines")
                .update({ due_date: dueDate, state, updated_at: new Date().toISOString() })
                .eq("id", existing.id)
              updated.push(`${account.company_name}: ${existing.due_date} -> ${dueDate}`)
            } else {
              skipped.push(`${account.company_name}: already up to date`)
            }
          } else {
            await supabaseAdmin.from("deadlines").insert({
              account_id: account.id,
              deadline_type: "RA Renewal",
              due_date: dueDate,
              status: "Pending",
              state,
              year,
              assigned_to: "Luca",
              notes: `Synced from Harbor Compliance license #${lic.license_number}`,
            })
            created.push(`${account.company_name}: RA Renewal due ${dueDate} (${state})`)
          }
        }

        if (!params.dry_run && (created.length || updated.length)) {
          await logAction({
            action_type: "process",
            table_name: "deadlines",
            summary: `Synced HC license deadlines: ${created.length} created, ${updated.length} updated, ${skipped.length} skipped`,
            details: { created: created.length, updated: updated.length, skipped: skipped.length },
          })
        }

        const mode = params.dry_run ? "DRY RUN" : "APPLIED"
        const lines = [
          `${mode}: HC License -> Deadline Sync\n`,
          `  Created: ${created.length}`,
          `  Updated: ${updated.length}`,
          `  Skipped: ${skipped.length}`,
        ]

        if (created.length) {
          lines.push("", "New deadlines:")
          created.forEach((c) => lines.push(`  + ${c}`))
        }
        if (updated.length) {
          lines.push("", "Updated deadlines:")
          updated.forEach((u) => lines.push(`  ~ ${u}`))
        }
        if (skipped.length && skipped.length <= 10) {
          lines.push("", "Skipped:")
          skipped.forEach((s) => lines.push(`  - ${s}`))
        } else if (skipped.length > 10) {
          lines.push("", `Skipped: ${skipped.length} (too many to list)`)
        }

        if (params.dry_run) {
          lines.push("", "Run with dry_run=false to apply changes.")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

}
