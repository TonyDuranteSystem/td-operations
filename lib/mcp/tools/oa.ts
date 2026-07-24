/**
 * Operating Agreement MCP Tools
 *
 * Tools:
 *   oa_create  — Create an OA record from CRM account data (SMLLC or MMLLC)
 *   oa_get     — Get OA details by token or account_id
 *   oa_send    — Send OA link to client via Gmail with tracking
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { getGreeting } from "@/lib/greeting"
import { safeSend } from "@/lib/mcp/safe-send"
import { OA_SUPPORTED_STATES } from "@/lib/types/oa-templates"
import { APP_BASE_URL } from "@/lib/config"
import { hasCollectedSignatures } from "@/lib/portal/oa-regenerate-guard"

const OA_BASE_URL = `${APP_BASE_URL}/operating-agreement`

export function registerOaTools(server: McpServer) {

  // ───────────────────────────────────────────────────────────
  // oa_create
  // ───────────────────────────────────────────────────────────
  server.tool(
    "oa_create",
    `Create a new Operating Agreement for a Single Member LLC (SMLLC) or Multi-Member LLC (MMLLC). All LLCs are manager-managed.

For SMLLC: pulls member info from primary linked contact (default).
For MMLLC: pass entity_type="MMLLC" and members array with name, ownership_pct, initial_contribution for each member.

Prerequisites:
- Account must exist with company_name and state_of_formation
- Account must have at least one linked contact
- For MMLLC: members array required, ownership_pct must total 100

Supported states: NM, WY, FL. English only.

Defaults: business_purpose="any and all lawful business activities", fiscal_year_end="December 31", accounting_method="Cash", duration="Perpetual", principal_address=Tony Durante LLC office.

The OA is created as 'draft'. Use oa_send to send the link to the client for signature.

Admin preview: append ?preview=td to the OA URL to bypass the email gate.
ALWAYS provide the admin preview link after creating an OA so Antonio can review it before sending.

Workflow: oa_create → oa_get (review via admin preview) → oa_send → client views → signs → PDF saved.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      entity_type: z.enum(["SMLLC", "MMLLC"]).optional().describe("Entity type: SMLLC (default) or MMLLC"),
      manager_name: z.string().optional().describe("Manager name (default: primary contact full_name). All LLCs are manager-managed."),
      members: z.array(z.object({
        name: z.string().describe("Member full name"),
        address: z.string().optional().describe("Member address"),
        email: z.string().optional().describe("Member email"),
        ownership_pct: z.number().describe("Ownership percentage (e.g. 99, 1)"),
        initial_contribution: z.string().optional().describe("Initial contribution (e.g. '$99.00'). Default: '$0.00'"),
      })).optional().describe("Members array for MMLLC. Required when entity_type=MMLLC. Must total 100%."),
      effective_date: z.string().optional().describe("Effective date YYYY-MM-DD (default: today). Cannot be more than 60 days in the past."),
      force_recreate: z.boolean().optional().describe("If true, delete the existing OA (and any MMLLC signatures) and create a fresh one. Requires confirmation — use only when the client needs a new OA with an updated effective date."),
      formation_date: z.string().optional().describe("Date LLC was formed YYYY-MM-DD (pulls from account if available)"),
      ein_number: z.string().optional().describe("EIN (pulls from account if available)"),
      business_purpose: z.string().optional().describe("Business purpose (default: 'any and all lawful business activities')"),
      initial_contribution: z.string().optional().describe("Initial capital contribution for SMLLC (default: '$0.00')"),
      fiscal_year_end: z.string().optional().describe("Fiscal year end (default: 'December 31')"),
      accounting_method: z.string().optional().describe("Accounting method (default: 'Cash')"),
      duration: z.string().optional().describe("Duration (default: 'Perpetual')"),
      registered_agent_name: z.string().optional().describe("Registered agent name"),
      registered_agent_address: z.string().optional().describe("Registered agent address"),
      principal_address: z.string().optional().describe("Principal office address (default: '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771')"),
      language: z.string().optional().describe("Language: 'en' only for now (default: 'en')"),
    },
    async (params) => {
      try {
        const entityType = params.entity_type || "SMLLC"

        // ─── MMLLC validation ───
        if (entityType === "MMLLC") {
          if (!params.members || params.members.length < 2) {
            return { content: [{ type: "text" as const, text: `❌ MMLLC requires at least 2 members. Pass members array.` }] }
          }
          const totalPct = params.members.reduce((sum, m) => sum + m.ownership_pct, 0)
          if (Math.abs(totalPct - 100) > 0.01) {
            return { content: [{ type: "text" as const, text: `❌ Member ownership percentages total ${totalPct}%, must equal 100%.` }] }
          }
        }

        // ─── 1. FETCH ACCOUNT ───
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, ein_number, state_of_formation, formation_date")
          .eq("id", params.account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `❌ Account not found: ${accErr?.message || "no data"}` }] }
        }

        // Validate state — normalize full name to abbreviation
        const STATE_MAP: Record<string, string> = {
          "NEW MEXICO": "NM", "NM": "NM",
          "WYOMING": "WY", "WY": "WY",
          "FLORIDA": "FL", "FL": "FL",
          "DELAWARE": "DE", "DE": "DE",
        }
        const rawState = (account.state_of_formation || "").toUpperCase().trim()
        const state = STATE_MAP[rawState] || rawState
        if (!OA_SUPPORTED_STATES.includes(state as typeof OA_SUPPORTED_STATES[number])) {
          return { content: [{ type: "text" as const, text: `❌ State "${account.state_of_formation}" not supported for OA. Supported: ${OA_SUPPORTED_STATES.join(", ")}` }] }
        }

        // ─── 2. FETCH PRIMARY CONTACT ───
        const { data: contactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", params.account_id)
          .limit(1)

        if (!contactLinks?.length) {
          return { content: [{ type: "text" as const, text: `❌ No contacts linked to account "${account.company_name}". Link a contact first.` }] }
        }

        const { data: contact, error: contactErr } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, email, phone, residency, language")
          .eq("id", contactLinks[0].contact_id)
          .single()

        if (contactErr || !contact) {
          return { content: [{ type: "text" as const, text: `❌ Contact not found: ${contactErr?.message || "no data"}` }] }
        }

        // ─── 3. VALIDATE EFFECTIVE DATE (60-day cap) ───
        const today = new Date().toISOString().slice(0, 10)
        const effectiveDate = params.effective_date || today
        const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        if (effectiveDate < cutoff) {
          return { content: [{ type: "text" as const, text: `❌ effective_date cannot be more than 60 days in the past. Earliest allowed: ${cutoff}` }] }
        }

        // ─── 4. CHECK DUPLICATE ───
        // ORDER BY created_at DESC is load-bearing, not cosmetic: without it an
        // account with more than one OA row returned an ARBITRARY row, while
        // oa_get and /portal/sign both read the NEWEST. force_recreate could
        // therefore delete a different agreement than the one staff were looking
        // at. (Council, 2026-07-22.)
        const { data: existing } = await supabaseAdmin
          .from("oa_agreements")
          .select("id, token, status, signed_count")
          .eq("account_id", params.account_id)
          .order("created_at", { ascending: false })
          .limit(1)

        if (existing?.length && !params.force_recreate) {
          return { content: [{ type: "text" as const, text: `⚠️ OA already exists for ${account.company_name} (token: ${existing[0].token}, status: ${existing[0].status}). Use oa_get to view it, or pass force_recreate=true to delete it and create a new one.` }] }
        }

        // ─── 5. FORCE RECREATE: delete existing OA ───
        // REFUSE if ANY signature has already been collected. Replacing an
        // UNSIGNED agreement is fine and expected — a new one supersedes the old
        // draft. Destroying a SIGNED one is not: the delete below removes the
        // oa_signatures rows and the agreement itself with no soft-delete and no
        // audit record (R100), so there is afterwards no evidence the client ever
        // signed — no signature, no date, nothing to show a bank or the IRS.
        //
        // The old guard was `status === 'signed'` only (and it lived on the
        // portal route, never here). That is wrong for a multi-member LLC, which
        // stays 'partially_signed' until the LAST member signs: a re-generate at
        // 2-of-3 erased two executed signatures and forced those members to sign
        // again with no trace they already had. Prod carries 73 signed OAs.
        // Same predicate as the client-facing route — one rule, both doors.
        if (existing?.length && params.force_recreate && hasCollectedSignatures(existing[0])) {
          return { content: [{ type: "text" as const, text: [
            `❌ Refusing to re-create: this Operating Agreement already carries a signature.`,
            ``,
            `  Company: ${account.company_name}`,
            `  Token:   ${existing[0].token}`,
            `  Status:  ${existing[0].status}${(existing[0].signed_count ?? 0) > 0 ? ` (${existing[0].signed_count} signature(s) collected)` : ""}`,
            ``,
            `force_recreate DELETES the agreement and every signature on it, with no`,
            `undo and no audit record. A signed OA is an executed legal document —`,
            `deleting it destroys the only proof the client signed.`,
            ``,
            `If the client genuinely needs a different agreement: void this one`,
            `(keeping the record), then create the new one.`,
          ].join("\n") }] }
        }

        if (existing?.length && params.force_recreate) {
          await supabaseAdmin.from("oa_signatures").delete().eq("oa_id", existing[0].id)
          const { error: delErr } = await supabaseAdmin.from("oa_agreements").delete().eq("id", existing[0].id)
          if (delErr) {
            return { content: [{ type: "text" as const, text: `❌ Failed to delete existing OA: ${delErr.message}` }] }
          }
        }

        // ─── 6. BUILD TOKEN ───
        const companySlug = account.company_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
        const year = new Date().getFullYear()
        const token = `${companySlug}-oa-${year}`

        // ─── 7. BUILD DATES ───
        const formationDate = params.formation_date || account.formation_date || today
        const ein = params.ein_number || account.ein_number || null
        const managerName = params.manager_name || contact.full_name

        // ─── 8. BUILD MEMBERS JSON (for MMLLC) ───
        const membersJson = entityType === "MMLLC" && params.members
          ? params.members.map(m => ({
              name: m.name,
              address: m.address || null,
              email: m.email || null,
              ownership_pct: m.ownership_pct,
              initial_contribution: m.initial_contribution || "$0.00",
            }))
          : null

        // ─── 9. INSERT ───
        const totalSigners = entityType === "MMLLC" && params.members ? params.members.length : 1

        const { data: oa, error: insertErr } = await supabaseAdmin
          .from("oa_agreements")
          .insert({
            token,
            account_id: params.account_id,
            contact_id: contact.id,
            company_name: account.company_name,
            state_of_formation: state,
            formation_date: formationDate,
            ein_number: ein,
            entity_type: entityType,
            manager_name: managerName,
            member_name: contact.full_name,
            member_address: contact.residency || null,
            member_email: contact.email || null,
            members: membersJson,
            effective_date: effectiveDate,
            business_purpose: params.business_purpose || "any and all lawful business activities",
            initial_contribution: params.initial_contribution || "$0.00",
            fiscal_year_end: params.fiscal_year_end || "December 31",
            accounting_method: params.accounting_method || "Cash",
            duration: params.duration || "Perpetual",
            registered_agent_name: params.registered_agent_name || null,
            registered_agent_address: params.registered_agent_address || null,
            principal_address: params.principal_address || "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
            language: params.language || "en",
            status: "draft",
            total_signers: totalSigners,
            signed_count: 0,
          })
          .select("id, token, access_code")
          .single()

        if (insertErr || !oa) {
          return { content: [{ type: "text" as const, text: `❌ Insert failed: ${insertErr?.message || "no data"}` }] }
        }

        // ─── 8. INSERT OA_SIGNATURES FOR MMLLC ───
        const signerLines: string[] = []
        if (entityType === "MMLLC" && params.members && params.members.length > 0) {
          // Auto-match contact_id by looking up member emails in account_contacts + contacts
          const { data: allContacts } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id, contacts(id, full_name, email)")
            .eq("account_id", params.account_id)

          const contactsByEmail = new Map<string, string>()
          const contactsByName = new Map<string, string>()
          for (const link of allContacts || []) {
            const c = link.contacts as unknown as { id: string; full_name: string; email: string } | null
            if (c?.email) contactsByEmail.set(c.email.toLowerCase(), c.id)
            if (c?.full_name) contactsByName.set(c.full_name.toLowerCase(), c.id)
          }

          const sigRows = params.members.map((m, idx) => {
            const matchedContactId = (m.email && contactsByEmail.get(m.email.toLowerCase()))
              || contactsByName.get(m.name.toLowerCase())
              || null
            return {
              oa_id: oa.id,
              member_index: idx,
              member_name: m.name,
              member_email: m.email || null,
              contact_id: matchedContactId,
            }
          })

          const { data: insertedSigs, error: sigErr } = await supabaseAdmin
            .from("oa_signatures")
            .insert(sigRows)
            .select("member_index, member_name, member_email, contact_id, access_code")

          if (sigErr) {
            // Non-blocking — OA is created, signatures failed
            signerLines.push(`⚠️ Failed to create signature rows: ${sigErr.message}`)
          } else if (insertedSigs) {
            for (const sig of insertedSigs) {
              const sigUrl = `${OA_BASE_URL}/${oa.token}/${oa.access_code}?signer=${sig.access_code}`
              const linked = sig.contact_id ? "✅ linked" : "⚠️ no contact"
              signerLines.push(`  ${sig.member_index + 1}. ${sig.member_name} (${sig.member_email || "no email"}) — ${linked}`)
              signerLines.push(`     🔗 ${sigUrl}`)
            }
          }
        }

        logAction({
          action_type: "create",
          table_name: "oa_agreements",
          record_id: oa.id,
          account_id: params.account_id,
          summary: `Created ${entityType} Operating Agreement for ${account.company_name} (${state})${totalSigners > 1 ? ` — ${totalSigners} signers` : ""}`,
          details: { token: oa.token, state, entity_type: entityType, manager: managerName, member: contact.full_name, total_signers: totalSigners },
        })

        const oaUrl = `${OA_BASE_URL}/${oa.token}/${oa.access_code}`
        const adminPreviewUrl = `${OA_BASE_URL}/${oa.token}?preview=td`

        const lines = [
          `✅ ${entityType} Operating Agreement created for **${account.company_name}**`,
          ``,
          `Token: ${oa.token}`,
          `State: ${state}`,
          `Entity Type: ${entityType}`,
          `Manager: ${managerName}`,
          entityType === "SMLLC"
            ? `Member: ${contact.full_name} (100%)`
            : `Members: ${params.members!.map(m => `${m.name} (${m.ownership_pct}%)`).join(", ")}`,
          totalSigners > 1 ? `Signers: ${totalSigners} (each member must sign)` : null,
          `Effective: ${effectiveDate}`,
          `Formation: ${formationDate}`,
          ein ? `EIN: ${ein}` : null,
          `Status: draft`,
          ``,
          `👁️ Admin Preview: ${adminPreviewUrl}`,
          entityType === "SMLLC" ? `🔗 Client URL: ${oaUrl}` : null,
          ...(signerLines.length > 0 ? [``, `📝 **Per-Member Signing Links:**`, ...signerLines] : []),
          ``,
          `⚠️ Review the admin preview FIRST, then use **oa_send** to send to ${totalSigners > 1 ? "each member" : "the client"}.`,
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // oa_get
  // ───────────────────────────────────────────────────────────
  server.tool(
    "oa_get",
    `Get full details of an Operating Agreement by token (e.g. 'acme-llc-oa-2026') or by account_id. Returns all fields including entity_type, members, manager, access_code, URL, status, signing info, and OA data.`,
    {
      token: z.string().optional().describe("OA token (e.g. 'acme-llc-oa-2026')"),
      account_id: z.string().uuid().optional().describe("Account UUID"),
    },
    async (params) => {
      try {
        let query = supabaseAdmin.from("oa_agreements").select("*")

        if (params.token) {
          query = query.eq("token", params.token)
        } else if (params.account_id) {
          query = query.eq("account_id", params.account_id).order("created_at", { ascending: false }).limit(1)
        } else {
          return { content: [{ type: "text" as const, text: "❌ Provide either token or account_id" }] }
        }

        const { data, error: err } = await query.single()

        if (err || !data) {
          return { content: [{ type: "text" as const, text: `❌ OA not found: ${err?.message || "no data"}` }] }
        }

        const url = `${OA_BASE_URL}/${data.token}/${data.access_code}`
        const adminPreviewUrl = `${OA_BASE_URL}/${data.token}?preview=td`
        const entityType = data.entity_type || "SMLLC"
        const members = data.members as Array<{ name: string; ownership_pct: number }> | null
        const totalSigners = data.total_signers || 1
        const signedCount = data.signed_count || 0

        // Fetch per-member signature status for MMLLC
        const signerLines: string[] = []
        if (entityType === "MMLLC" && totalSigners > 1) {
          const { data: sigs } = await supabaseAdmin
            .from("oa_signatures")
            .select("member_index, member_name, member_email, contact_id, access_code, status, signed_at")
            .eq("oa_id", data.id)
            .order("member_index")

          if (sigs && sigs.length > 0) {
            signerLines.push(``, `📝 **Signatures: ${signedCount}/${totalSigners}**`)
            for (const sig of sigs) {
              const icon = sig.status === "signed" ? "✅" : sig.status === "viewed" ? "👁️" : sig.status === "sent" ? "📧" : "⏳"
              const sigUrl = `${OA_BASE_URL}/${data.token}/${data.access_code}?signer=${sig.access_code}`
              signerLines.push(`  ${icon} ${sig.member_name} (${sig.member_email || "no email"}) — ${sig.status}${sig.signed_at ? ` (${sig.signed_at})` : ""}`)
              if (sig.status !== "signed") {
                signerLines.push(`     🔗 ${sigUrl}`)
              }
            }
          }
        }

        const statusDisplay = data.status === "partially_signed"
          ? `partially_signed (${signedCount}/${totalSigners})`
          : data.status

        const lines = [
          `📄 **Operating Agreement**`,
          ``,
          `Token: ${data.token}`,
          `Status: ${statusDisplay}`,
          `Entity Type: ${entityType}`,
          ``,
          `**Company:** ${data.company_name}`,
          `State: ${data.state_of_formation}`,
          data.ein_number ? `EIN: ${data.ein_number}` : null,
          `Formation Date: ${data.formation_date}`,
          ``,
          `**Manager:** ${data.manager_name || data.member_name}`,
          entityType === "MMLLC" && members
            ? `**Members:**\n${members.map(m => `  - ${m.name} (${m.ownership_pct}%)`).join("\n")}`
            : `**Member:** ${data.member_name}`,
          data.member_address ? `Address: ${data.member_address}` : null,
          data.member_email ? `Email: ${data.member_email}` : null,
          ``,
          `Effective Date: ${data.effective_date}`,
          `Purpose: ${data.business_purpose}`,
          `Contribution: ${data.initial_contribution}`,
          `Fiscal Year: ${data.fiscal_year_end}`,
          `Accounting: ${data.accounting_method}`,
          `Duration: ${data.duration}`,
          ``,
          data.registered_agent_name ? `Registered Agent: ${data.registered_agent_name}` : null,
          `Principal Office: ${data.principal_address}`,
          ``,
          `Views: ${data.view_count}${data.viewed_at ? ` (last: ${data.viewed_at})` : ""}`,
          // Distinguish an executed electronic signature (we hold the signature,
          // the IP/device/consent trail and a certificate) from the client merely
          // telling us they signed on paper (we hold nothing unless they uploaded
          // a scan). Printing "✅ Signed" for both was the exact question
          // signature_method was added to answer, and no staff surface answered it.
          // THREE states, not two. NULL means the row predates the distinction
          // (~73 signed agreements on production do) — those were signed with the
          // old browser screenshot and carry NO certificate, IP or device trail.
          // Reporting them as "signed electronically … certificate on file" would
          // assert evidence TD does not hold.
          data.signed_at
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer than the generated DB types
            ? ((data as any).signature_method === "by_hand"
                ? `✍️ Signed ON PAPER (client-declared): ${data.signed_at} — TD holds no electronic signature; the signed copy exists only if the client uploaded a scan (check the account's documents).`
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer than the generated DB types
                : (data as any).signature_method === "electronic"
                  ? `✅ Signed electronically: ${data.signed_at} — signature, device/IP trail and certificate on file.`
                  : `✅ Signed: ${data.signed_at} — legacy record (predates signature tracking): a signed PDF exists, but NO certificate, IP or device trail.`)
            : "⏳ Not signed yet",
          data.pdf_storage_path ? `PDF: ${data.pdf_storage_path}` : null,
          ...signerLines,
          ``,
          `👁️ Admin Preview: ${adminPreviewUrl}`,
          entityType === "SMLLC" ? `🔗 Client URL: ${url}` : null,
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // oa_send
  // ───────────────────────────────────────────────────────────
  server.tool(
    "oa_send",
    `Send the Operating Agreement link to the member via Gmail with open tracking. Sets status to 'sent'. Email is sent immediately (NOT a draft). For MMLLC: sends individual personalized emails to each unsigned member with their specific signing link. Requires member_email to be set. Use gmail_track_status to check if the client opened the email.`,
    {
      token: z.string().describe("OA token to send"),
    },
    async (params) => {
      try {
        // Fetch OA
        const { data: oa, error: err } = await supabaseAdmin
          .from("oa_agreements")
          .select("*")
          .eq("token", params.token)
          .single()

        if (err || !oa) {
          return { content: [{ type: "text" as const, text: `❌ OA not found: ${err?.message || "no data"}` }] }
        }

        // ⛔ Never re-send a TERMINAL agreement. The send unconditionally flips the
        // row back to 'sent' (see the postSendStep below), so without this a
        // routine "resend it, they say they never got it" would:
        //   • VOIDED  → resurrect a cancelled agreement, making it reachable and
        //     actionable again in the client's portal;
        //   • SIGNED  → email "ready for your review and signature" for an already
        //     EXECUTED document and make it read as unsigned everywhere.
        if (oa.status === "voided") {
          return { content: [{ type: "text" as const, text: [
            `❌ Refusing to send: OA "${params.token}" is VOIDED.`,
            ``,
            `  Company: ${oa.company_name}`,
            ``,
            `A voided agreement is cancelled on purpose. Sending it would make it live`,
            `again in the client's portal. Create a NEW agreement instead.`,
          ].join("\n") }] }
        }
        if (oa.status === "signed") {
          return { content: [{ type: "text" as const, text: [
            `❌ Refusing to send: OA "${params.token}" is already SIGNED.`,
            ``,
            `  Company: ${oa.company_name}`,
            `  Signed:  ${oa.signed_at ?? "—"}`,
            ``,
            `This is an executed document. Sending it would ask the client to sign again`,
            `and make the signed agreement read as unsigned across the portal and CRM.`,
            `Use oa_get to fetch the signed copy.`,
          ].join("\n") }] }
        }

        const entityType = oa.entity_type || "SMLLC"
        const totalSigners = oa.total_signers || 1
        const isMMLC = entityType === "MMLLC" && totalSigners > 1

        // ─── MMLLC: send per-member emails ───
        if (isMMLC) {
          const { data: sigs } = await supabaseAdmin
            .from("oa_signatures")
            .select("*")
            .eq("oa_id", oa.id)
            .order("member_index")

          if (!sigs || sigs.length === 0) {
            return { content: [{ type: "text" as const, text: `❌ No signature rows found for MMLLC OA "${params.token}". Re-create the OA.` }] }
          }

          const unsignedMembers = sigs.filter(s => s.status !== "signed")
          if (unsignedMembers.length === 0) {
            return { content: [{ type: "text" as const, text: `✅ All ${totalSigners} members have already signed OA "${params.token}".` }] }
          }

          const { gmailPost } = await import("@/lib/gmail")
          const entityLabel = "Multi-Member"
          const fromEmail = "support@tonydurante.us"
          const subject = `Operating Agreement — ${oa.company_name}`
          const resultLines: string[] = []
          const warnings: string[] = []

          for (const sig of unsignedMembers) {
            if (!sig.member_email) {
              warnings.push(`⚠️ ${sig.member_name}: no email — must sign via portal`)
              continue
            }

            // Look up contact for greeting
            const { data: contactRow } = await supabaseAdmin
              .from("contacts")
              .select("gender, last_name, language, full_name")
              .eq("id", sig.contact_id!)
              .maybeSingle()

            const firstName = contactRow?.full_name?.split(" ")[0] || sig.member_name.split(" ")[0]
            const greeting = getGreeting({
              firstName,
              lastName: contactRow?.last_name,
              gender: contactRow?.gender,
              language: contactRow?.language,
            })

            const sigUrl = `${OA_BASE_URL}/${oa.token}/${oa.access_code}?signer=${sig.access_code}`
            const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`

            const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>${greeting},</p>
  <p>Your Operating Agreement for <strong>${oa.company_name}</strong> is ready for your review and signature.</p>
  <p style="margin: 24px 0;">
    <a href="${sigUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      Review &amp; Sign Operating Agreement
    </a>
  </p>
  <p>You will be asked to verify your email address (<strong>${sig.member_email}</strong>) to access the document.</p>
  <p>The Operating Agreement covers the formation and governance of your ${oa.state_of_formation} ${entityLabel} LLC, including:</p>
  <ul style="line-height: 1.8;">
    <li>Management structure (Manager-Managed)</li>
    <li>Member rights and responsibilities</li>
    <li>Capital contributions and distributions</li>
    <li>State-specific provisions for ${oa.state_of_formation}</li>
  </ul>
  <p>All ${totalSigners} members must sign for the agreement to be effective.</p>
  <p>If you have any questions, please reply to this email or contact us on WhatsApp.</p>
  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>
<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

            const plainText = `${greeting},

Your Operating Agreement for ${oa.company_name} is ready for your review and signature.

Review and sign: ${sigUrl}

You will be asked to verify your email address (${sig.member_email}).

All ${totalSigners} members must sign for the agreement to be effective.

Best regards,
Tony Durante LLC`

            const boundary = `boundary_${Date.now()}_${sig.member_index}`
            const hasNonAscii = /[^\x00-\x7F]/.test(subject)
            const encodedSubject = hasNonAscii
              ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
              : subject

            const mimeParts = [
              [`From: Tony Durante LLC <${fromEmail}>`, `To: ${sig.member_email}`, `Subject: ${encodedSubject}`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`].join("\r\n"),
              "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(plainText).toString("base64"),
              "", `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(htmlBody).toString("base64"),
              "", `--${boundary}--`,
            ]
            const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

            try {
              const gmailResult = await gmailPost("/messages/send", { raw: encodedRaw }) as { id: string; threadId: string }

              // Save tracking
              await supabaseAdmin.from("email_tracking").insert({
                tracking_id: trackingId,
                gmail_message_id: gmailResult.id,
                gmail_thread_id: gmailResult.threadId,
                recipient: sig.member_email,
                subject,
                from_email: fromEmail,
                account_id: oa.account_id || null,
              })

              // Update signature row
              await supabaseAdmin
                .from("oa_signatures")
                .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq("id", sig.id)

              resultLines.push(`✅ ${sig.member_name} (${sig.member_email}) — sent (${gmailResult.id})`)
            } catch (sendErr) {
              resultLines.push(`❌ ${sig.member_name} (${sig.member_email}) — failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`)
            }
          }

          // Update OA status to 'sent' if it was 'draft'
          if (["draft", "viewed"].includes(oa.status)) {
            await supabaseAdmin
              .from("oa_agreements")
              .update({ status: "sent", updated_at: new Date().toISOString() })
              .eq("id", oa.id)
          }

          logAction({
            action_type: "send",
            table_name: "oa_agreements",
            record_id: oa.id,
            account_id: oa.account_id,
            summary: `Sent MMLLC OA emails for ${oa.company_name} to ${unsignedMembers.filter(s => s.member_email).length} members`,
            details: { token: params.token, members_sent: resultLines.length },
          })

          return { content: [{ type: "text" as const, text: [
            `📧 **OA emails sent for ${oa.company_name}** (${unsignedMembers.length} unsigned members)`,
            ``,
            ...resultLines,
            ...warnings,
            ``,
            `Use gmail_track_status to check if members opened the emails.`,
          ].join("\n") }] }
        }

        // ─── SMLLC: existing single-member flow ───
        if (!oa.member_email) {
          return { content: [{ type: "text" as const, text: `❌ No member_email set on OA "${params.token}". Update the contact record first.` }] }
        }

        const url = `${OA_BASE_URL}/${oa.token}/${oa.access_code}`
        const { gmailPost } = await import("@/lib/gmail")

        const { data: contactRow } = await supabaseAdmin
          .from("contacts")
          .select("gender, last_name, language")
          .eq("email", oa.member_email)
          .single()
        const greeting = getGreeting({
          firstName: oa.member_name,
          lastName: contactRow?.last_name,
          gender: contactRow?.gender,
          language: contactRow?.language,
        })

        const entityLabel = "Single Member"
        const subject = `Operating Agreement — ${oa.company_name}`
        const fromEmail = "support@tonydurante.us"
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`

        const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>${greeting},</p>
  <p>Your Operating Agreement for <strong>${oa.company_name}</strong> is ready for your review and signature.</p>
  <p style="margin: 24px 0;">
    <a href="${url}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      Review &amp; Sign Operating Agreement
    </a>
  </p>
  <p>You will be asked to verify your email address (<strong>${oa.member_email}</strong>) to access the document.</p>
  <p>The Operating Agreement covers the formation and governance of your ${oa.state_of_formation} ${entityLabel} LLC, including:</p>
  <ul style="line-height: 1.8;">
    <li>Management structure (Manager-Managed)</li>
    <li>Member rights and responsibilities</li>
    <li>Capital contributions and distributions</li>
    <li>State-specific provisions for ${oa.state_of_formation}</li>
  </ul>
  <p>If you have any questions, please reply to this email or contact us on WhatsApp.</p>
  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>
<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

        const plainText = `${greeting},

Your Operating Agreement for ${oa.company_name} is ready for your review and signature.

Review and sign the agreement online:
${url}

You will be asked to verify your email address (${oa.member_email}) to access the document.

Best regards,
Tony Durante LLC
support@tonydurante.us`

        const boundary = `boundary_${Date.now()}`
        const hasNonAscii = /[^\x00-\x7F]/.test(subject)
        const encodedSubject = hasNonAscii
          ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
          : subject

        const mimeParts = [
          [`From: Tony Durante LLC <${fromEmail}>`, `To: ${oa.member_email}`, `Subject: ${encodedSubject}`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`].join("\r\n"),
          "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(plainText).toString("base64"),
          "", `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(htmlBody).toString("base64"),
          "", `--${boundary}--`,
        ]
        const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

        const result = await safeSend<{ id: string; threadId: string }>({
          idempotencyCheck: async () => {
            if (oa.status === "sent") {
              // Scope the probe to THIS agreement. The subject+recipient match is
              // not OA-specific, so without the created_at bound an email sent for
              // a PREVIOUS agreement for the same company would suppress the send
              // for a newly created one — and the client would wait forever for a
              // link that never went out. This matters now that the portal
              // self-service route creates OAs at 'sent' (see create/route.ts):
              // re-generating deletes the old row and inserts a new one, so a
              // prior email for the same company is the normal case, not the
              // exception.
              const { data: existing } = await supabaseAdmin
                .from("email_tracking")
                .select("tracking_id, created_at")
                .eq("recipient", oa.member_email!)
                .ilike("subject", `%Operating Agreement%${oa.company_name}%`)
                .gte("created_at", oa.created_at)
                .limit(1)
              if (existing?.length) {
                return {
                  alreadySent: true,
                  message: `⚠️ OA email already sent for "${params.token}"\n\nTracking: ${existing[0].tracking_id}\nSent at: ${existing[0].created_at}\n\nUse gmail_track_status to check if the client opened it.`,
                }
              }
            }
            return null
          },
          sendFn: async () => {
            return await gmailPost("/messages/send", { raw: encodedRaw }) as { id: string; threadId: string }
          },
          postSendSteps: [
            {
              name: "save_tracking",
              fn: async () => {
                await supabaseAdmin.from("email_tracking").insert({
                  tracking_id: trackingId,
                  gmail_message_id: result.sendResult?.id,
                  gmail_thread_id: result.sendResult?.threadId,
                  recipient: oa.member_email,
                  subject,
                  from_email: fromEmail,
                  account_id: oa.account_id || null,
                })
              },
            },
            {
              name: "update_status",
              fn: async () => {
                await supabaseAdmin
                  .from("oa_agreements")
                  .update({ status: "sent", updated_at: new Date().toISOString() })
                  .eq("id", oa.id)
              },
            },
          ],
        })

        if (result.alreadySent) {
          return { content: [{ type: "text" as const, text: result.idempotencyMessage! }] }
        }

        logAction({
          action_type: "send",
          table_name: "oa_agreements",
          record_id: oa.id,
          account_id: oa.account_id,
          summary: `Sent OA email for ${oa.company_name} to ${oa.member_email}`,
          details: { token: params.token, gmail_message_id: result.sendResult?.id, tracking_id: trackingId },
        })

        const statusLine = result.hasWarnings
          ? `⚠️ Email sent but some follow-up steps had issues`
          : `✅ OA email sent via Gmail`

        return { content: [{ type: "text" as const, text: [
          statusLine,
          ``,
          `📧 To: ${oa.member_email}`,
          `📋 Subject: ${subject}`,
          `🆔 Message ID: ${result.sendResult?.id}`,
          `👁️ Open tracking: ${trackingId}`,
          ``,
          result.hasWarnings ? `⚠️ Steps: ${result.steps.map(s => `${s.step}=${s.status}`).join(", ")}` : "",
          `Use gmail_track_status to check if the client opened the email.`,
        ].filter(Boolean).join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error sending OA email (OA status NOT changed): ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

} // end registerOaTools

