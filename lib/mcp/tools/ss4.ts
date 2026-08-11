/**
 * SS-4 (EIN Application) MCP Tools
 *
 * Tools:
 *   ss4_create — Create a pre-filled SS-4 application from CRM account data
 *   ss4_get    — Get SS-4 details by token or account_id
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"
import { createSS4 } from "@/lib/operations/ss4"

export function registerSs4Tools(server: McpServer) {

  // ───────────────────────────────────────────────────────────
  // ss4_create
  // ───────────────────────────────────────────────────────────
  server.tool(
    "ss4_create",
    `Create a pre-filled SS-4 (EIN Application) for a client's LLC. Pulls data from CRM account + primary contact.

Prerequisites:
- Account must exist with company_name, state_of_formation, and formation_date
- Account must have at least one linked contact (the responsible party)

Entity type rules (auto-detected from account):
- SMLLC: Line 9a = "Other: Foreign owned disregarded entity", title = "Owner"
- MMLLC: Line 9a = "Partnership", title = "Member". IMPORTANT: For MMLLC with multiple members, you MUST provide contact_id to specify which member signs. If omitted, the tool will list all members and ask you to choose.
- Corporation: Line 9a = "Corporation" + "1120", title = "President". After EIN is received, Form 8832 must be filed for C-Corp election.

By default the SS-4 is created as 'draft' for admin review. Pass ready_to_sign=true to create it directly at 'awaiting_signature' so it appears in the client's portal Sign Documents page immediately without a manual status flip.
After signing, Luca receives a notification to fax it to the IRS.

Admin preview: ${APP_BASE_URL}/ss4/{token}/{access_code}?preview=td
ALWAYS provide the admin preview link after creating.

Workflow: ss4_create → client sees it in portal → signs → Luca faxes to IRS → EIN received.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID for responsible party (auto-detects primary contact if omitted)"),
      entity_type: z.enum(["SMLLC", "MMLLC", "Corporation"]).optional().describe("Entity type (auto-detected from account.entity_type if omitted)"),
      member_count: z.number().optional().describe("Number of LLC members (auto: 1 for SMLLC, from account_contacts for MMLLC)"),
      ready_to_sign: z.boolean().optional().describe("If true, creates the record at 'awaiting_signature' so it surfaces in the client's portal Sign Documents page immediately. Default false (creates at 'draft' for admin review first)."),
    },
    async (params) => {
      try {
        // Delegates to the shared core (lib/operations/ss4.ts) so the flow
        // Workspace + advance hook reuse the exact same logic. This handler only
        // formats the structured result back into MCP text.
        const result = await createSS4({
          account_id: params.account_id,
          contact_id: params.contact_id,
          entity_type: params.entity_type,
          member_count: params.member_count,
          ready_to_sign: params.ready_to_sign,
        })

        if (!result.ok || !result.ss4) {
          // already_exists / needs_signer_selection / missing prerequisites all
          // carry a ready-to-show message (verbatim from the original tool).
          return { content: [{ type: "text" as const, text: result.message ?? `Error (${result.outcome})` }] }
        }

        const s = result.ss4
        return {
          content: [{
            type: "text" as const,
            text: [
              `SS-4 created for ${s.company_name}`,
              ``,
              `Token: ${s.token}`,
              `Status: ${s.status}`,
              `Entity: ${s.entity_type} (${s.member_count} member${s.member_count > 1 ? "s" : ""})`,
              `State: ${s.state}`,
              `Responsible Party: ${s.responsible_party_name}`,
              ``,
              `Admin Preview: ${result.previewUrl}`,
              ``,
              `The client will see this in their portal Sign Documents page.`,
            ].join("\n"),
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // ss4_update
  // ───────────────────────────────────────────────────────────
  server.tool(
    "ss4_update",
    `Update fields on an existing SS-4 application. If the record is at 'awaiting_signature', updating any content field resets it to 'draft' so the client sees the corrected version before re-signing.

Use cases:
- Correct responsible party (new contact_id — MUST be a contact linked to the account; runs the shared signer-switch: rewrites name/ITIN/phone as a set, resets awaiting_signature to draft, and ROTATES the access code so the previous signing link stops working)
- Fix member_count
- Add county_and_state or trade_name
- Promote draft → awaiting_signature (pass status='awaiting_signature' explicitly)
- Reset to draft after a signing error

Note: signed records (status='signed') cannot be updated.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("New responsible party contact UUID"),
      member_count: z.number().optional().describe("Corrected member count"),
      county_and_state: z.string().optional().describe("County and state of principal business address"),
      trade_name: z.string().optional().describe("Trade name / DBA (if any)"),
      status: z.enum(["draft", "awaiting_signature"]).optional().describe("Explicitly set status (omit to let the tool auto-manage)"),
    },
    async (params) => {
      try {
        // ── Responsible-party change goes through the SINGLE switch core ──
        // (lib/operations/ss4-set-signer.ts). Before 2026-08-10 this tool
        // rewrote the four party columns itself — a second, WEAKER switch path:
        // no access-code rotation (the old signer's link stayed live), no
        // members.is_signer sync, no documents repoint, no chat/bell cleanup —
        // so an MCP-driven correction could be silently reverted by the next
        // refresh. Now both surfaces share setSs4Signer. Note this also
        // enforces that the new signer is LINKED to the account.
        let switchNote = ""
        if (params.contact_id) {
          const { setSs4Signer } = await import("@/lib/operations/ss4-set-signer")
          const sw = await setSs4Signer({
            account_id: params.account_id,
            contact_id: params.contact_id,
            source: "mcp-ss4-update",
          })
          if (!sw.ok && sw.outcome !== "unchanged") {
            return { content: [{ type: "text" as const, text: `Error: ${sw.message || `Could not change the responsible party (${sw.outcome}).`}` }] }
          }
          if (sw.outcome === "switched") {
            switchNote = sw.statusReset
              ? "\nResponsible party changed — status reset to draft and the previous signing link was revoked (access code rotated)."
              : "\nResponsible party changed — the previous signing link was revoked (access code rotated)."
          } else if (sw.outcome === "unchanged") {
            switchNote = "\nResponsible party unchanged (that contact is already the signer)."
          }
        }

        // Re-fetch AFTER any switch: the status may have reset to draft and the
        // access code rotated — the logic below must see the post-switch row.
        const { data: ss4, error: fetchErr } = await supabaseAdmin
          .from("ss4_applications")
          .select("id, token, status, company_name, access_code, county_and_state, entity_type")
          .eq("account_id", params.account_id)
          .maybeSingle()

        // A COMMITTED switch must never be hidden by a later error (council
        // minor, 2026-08-11): every error return below carries switchNote, so
        // staff always learn that the party already changed, the old link is
        // already dead, and (if it was awaiting) the record is now draft.
        const withSwitch = (text: string) => ({
          content: [{ type: "text" as const, text: `${text}${switchNote}` }],
        })

        if (fetchErr || !ss4) {
          return withSwitch(`Error: SS-4 not found for this account: ${fetchErr?.message || "no data"}`)
        }

        if (ss4.status === "signed" || ss4.status === "submitted") {
          return withSwitch(`Error: SS-4 for ${ss4.company_name} has status '${ss4.status}' — it cannot be modified after signing/submission.`)
        }

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

        if (params.member_count !== undefined) updates.member_count = params.member_count
        if (params.county_and_state !== undefined) updates.county_and_state = params.county_and_state
        if (params.trade_name !== undefined) updates.trade_name = params.trade_name

        const contentFieldsChanged = Object.keys(updates).some(k => k !== "updated_at" && k !== "status")

        // Status logic: explicit override wins; otherwise reset to draft if content changed while awaiting_signature
        if (params.status) {
          // Block awaiting_signature if county_and_state would remain blank
          if (params.status === "awaiting_signature") {
            const resolvedCounty = (params.county_and_state as string | undefined) || (ss4.county_and_state as string | undefined)
            if (!resolvedCounty) {
              return withSwitch(`Error: Cannot advance SS-4 for ${ss4.company_name} to awaiting_signature — county_and_state (Line 6) is blank. Line 6 is sourced from the account's Registered Agent address. Add or correct the Registered Agent address on the account, then re-run ss4_update — the value will populate automatically. If the RA address is correct but unrecognized by the helper, set county_and_state explicitly: ss4_update(..., county_and_state: "<County>, <State>").`)
            }
          }
          updates.status = params.status
        } else if (contentFieldsChanged && ss4.status === "awaiting_signature") {
          updates.status = "draft"
        }

        // Signed-row guard on the residual write too (council minor): the client
        // may sign between the re-fetch above and this update — the same TOCTOU
        // pattern the switch core and refresh already carry.
        const { data: updatedRows, error: updateErr } = await supabaseAdmin
          .from("ss4_applications")
          .update(updates)
          .eq("id", ss4.id)
          .in("status", ["draft", "awaiting_signature"])
          .is("signed_at", null)
          .select("id")

        if (updateErr) {
          return withSwitch(`Error updating SS-4: ${updateErr.message}`)
        }
        if (!updatedRows || updatedRows.length === 0) {
          return withSwitch(`Error: the SS-4 for ${ss4.company_name} was signed while this update was running — the remaining fields were left untouched.`)
        }

        await logAction({
          action_type: "update",
          table_name: "ss4_applications",
          record_id: ss4.id,
          account_id: params.account_id,
          summary: `Updated SS-4 for ${ss4.company_name} — fields: ${Object.keys(updates).filter(k => k !== "updated_at").join(", ")}`,
        })

        // Sync corrected member_count back to accounts (always overwrite on explicit update)
        // Cast needed: member_count not yet in generated types (migration pending production).
        if (params.member_count !== undefined && ss4.entity_type === "MMLLC") {
          // eslint-disable-next-line no-restricted-syntax
          await supabaseAdmin
            .from("accounts")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .update({ member_count: params.member_count } as any)
            .eq("id", params.account_id)
        }

        const newStatus = (updates.status as string | undefined) || ss4.status

        // Promotion to awaiting_signature = the client can sign NOW → notify
        // the signer (chat + immediate email + bell/push). Only on a REAL
        // transition (was not already awaiting), never on content edits.
        // Best-effort — the update above already committed.
        let notifyNote = ""
        if (updates.status === "awaiting_signature" && ss4.status !== "awaiting_signature") {
          try {
            const { notifySs4ReadyToSign } = await import("@/lib/portal/action-required")
            const notify = await notifySs4ReadyToSign({ ss4Id: ss4.id as string })
            notifyNote = `\nClient notified: chat=${notify.chat}, email=${notify.email}, portal=${notify.notification}`
          } catch (notifyErr) {
            notifyNote = `\n⚠️ Client notification failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
          }
        }

        const previewUrl = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`
        const resetNote = updates.status === "draft" && ss4.status === "awaiting_signature"
          ? "\n⚠️  Status reset to draft — content was changed while record was awaiting_signature."
          : ""

        return {
          content: [{
            type: "text" as const,
            text: [
              `SS-4 updated for ${ss4.company_name}`,
              `Status: ${newStatus}`,
              `Fields updated: ${Object.keys(updates).filter(k => k !== "updated_at" && k !== "status").join(", ") || "none"}`,
              switchNote,
              resetNote,
              notifyNote,
              ``,
              `Admin Preview: ${previewUrl}`,
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // ss4_get
  // ───────────────────────────────────────────────────────────
  server.tool(
    "ss4_get",
    `Get SS-4 application details by token or account_id. Returns all fields including status, signing info, and preview URL.`,
    {
      token: z.string().optional().describe("SS-4 token (e.g. 'ss4-outriders-llc-2026')"),
      account_id: z.string().uuid().optional().describe("Account UUID"),
    },
    async (params) => {
      try {
        let query = supabaseAdmin
          .from("ss4_applications")
          .select("*")

        if (params.token) {
          query = query.eq("token", params.token)
        } else if (params.account_id) {
          query = query.eq("account_id", params.account_id).order("created_at", { ascending: false }).limit(1)
        } else {
          return { content: [{ type: "text" as const, text: "Error: Provide either token or account_id" }] }
        }

        const { data: ss4, error } = await query.maybeSingle()

        if (error || !ss4) {
          return { content: [{ type: "text" as const, text: `SS-4 not found: ${error?.message || "no data"}` }] }
        }

        const previewUrl = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`

        return {
          content: [{
            type: "text" as const,
            text: [
              `SS-4 Application: ${ss4.company_name}`,
              ``,
              `ID: ${ss4.id}`,
              `Token: ${ss4.token}`,
              `Status: ${ss4.status}`,
              `Entity: ${ss4.entity_type} (${ss4.member_count} member${ss4.member_count > 1 ? "s" : ""})`,
              `State: ${ss4.state_of_formation}`,
              `Formation Date: ${ss4.formation_date || "N/A"}`,
              `Responsible Party: ${ss4.responsible_party_name}`,
              `ITIN: ${ss4.responsible_party_itin || "Foreigner"}`,
              ``,
              ss4.signed_at ? `Signed: ${ss4.signed_at}` : "Not yet signed",
              ss4.pdf_signed_drive_id ? `Signed PDF (Drive): ${ss4.pdf_signed_drive_id}` : "",
              ``,
              `Views: ${ss4.view_count || 0}`,
              `Created: ${ss4.created_at}`,
              ``,
              `Admin Preview: ${previewUrl}`,
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )
}
