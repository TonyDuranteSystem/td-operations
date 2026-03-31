import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { downloadFileBinary } from "@/lib/google-drive"

export function registerSignatureTools(server: McpServer) {
  server.tool(
    "signature_request_create",
    "Create a signature request for any PDF document. Downloads the PDF from Google Drive, stores it in Supabase Storage, and creates a signing link. The client can sign it in the portal or via the standalone URL. Use this for Form 8879, engagement letters, or any document that needs a client signature.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      document_name: z.string().describe("Display name (e.g., 'Form 8879 - IRS E-File Authorization')"),
      description: z.string().optional().describe("Optional description shown to the signer"),
      drive_file_id: z.string().describe("Google Drive file ID of the source PDF"),
      signature_coords: z.object({
        x: z.number().describe("X position in PDF points from left"),
        y: z.number().describe("Y position in PDF points from bottom"),
        page: z.number().describe("Page number (0-indexed)"),
      }).optional().describe("Where to overlay the signature on the PDF. Defaults to bottom of first page."),
    },
    async ({ account_id, contact_id, document_name, description, drive_file_id, signature_coords }) => {
      try {
        // Resolve contact
        let resolvedContactId = contact_id
        if (!resolvedContactId) {
          const { data: links } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id")
            .eq("account_id", account_id)
            .limit(1)
          if (!links?.length) {
            return { content: [{ type: "text" as const, text: "No contacts linked to this account" }] }
          }
          resolvedContactId = links[0].contact_id
        }

        // Get contact email for the signing page
        const { data: contactData } = await supabaseAdmin
          .from("contacts")
          .select("full_name, email")
          .eq("id", resolvedContactId)
          .single()

        if (!contactData?.email) {
          return { content: [{ type: "text" as const, text: "Contact has no email address" }] }
        }

        // Get account for company name
        const { data: account } = await supabaseAdmin
          .from("accounts")
          .select("company_name, drive_folder_id")
          .eq("id", account_id)
          .single()

        if (!account) {
          return { content: [{ type: "text" as const, text: "Account not found" }] }
        }

        // Generate token
        const slug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        const docSlug = document_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)
        const token = `sig-${slug}-${docSlug}-${Date.now().toString(36)}`

        // Download PDF from Drive
        const { buffer, fileName } = await downloadFileBinary(drive_file_id)

        // Upload to Supabase Storage
        const storagePath = `${token}/${fileName}`
        const { error: uploadError } = await supabaseAdmin.storage
          .from("signature-requests")
          .upload(storagePath, buffer, { contentType: "application/pdf", upsert: false })

        if (uploadError) {
          return { content: [{ type: "text" as const, text: `Storage upload failed: ${uploadError.message}` }] }
        }

        // Insert signature_request
        const coords = signature_coords || { x: 150, y: 80, page: 0 }
        const { data: sigReq, error: insertError } = await supabaseAdmin
          .from("signature_requests")
          .insert({
            token,
            account_id,
            contact_id: resolvedContactId,
            document_name,
            description: description || null,
            pdf_storage_path: storagePath,
            signature_coords: coords,
            status: "draft",
            created_by: "claude",
          })
          .select("id, token, access_code")
          .single()

        if (insertError || !sigReq) {
          return { content: [{ type: "text" as const, text: `DB insert failed: ${insertError?.message || "unknown"}` }] }
        }

        logAction({
          action_type: "create",
          table_name: "signature_requests",
          record_id: sigReq.id,
          account_id,
          summary: `Signature request created: ${document_name} for ${contactData.full_name}`,
        })

        const clientUrl = `${APP_BASE_URL}/sign-document/${sigReq.token}/${sigReq.access_code}`
        const previewUrl = `${APP_BASE_URL}/sign-document/${sigReq.token}/${sigReq.access_code}?preview=td`

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Signature request created`,
              `Document: ${document_name}`,
              `Company: ${account.company_name}`,
              `Signer: ${contactData.full_name} (${contactData.email})`,
              `Token: ${sigReq.token}`,
              ``,
              `👁️ Admin Preview: ${previewUrl}`,
              `🔗 Client URL: ${clientUrl}`,
              ``,
              `The document will appear in the client's portal under "Sign Documents".`,
            ].join("\n"),
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  server.tool(
    "signature_request_get",
    "Get details of a signature request by token or account_id. Returns status, document name, signer, and URLs.",
    {
      token: z.string().optional().describe("Signature request token"),
      account_id: z.string().uuid().optional().describe("Account UUID (returns all signature requests)"),
    },
    async ({ token, account_id }) => {
      try {
        if (token) {
          const { data, error } = await supabaseAdmin
            .from("signature_requests")
            .select("*, accounts!inner(company_name), contacts!inner(full_name, email)")
            .eq("token", token)
            .single()

          if (error || !data) {
            return { content: [{ type: "text" as const, text: `Not found: ${error?.message || "no match"}` }] }
          }

          const acct = data.accounts as unknown as { company_name: string }
          const contact = data.contacts as unknown as { full_name: string; email: string }

          return {
            content: [{
              type: "text" as const,
              text: [
                `📄 Signature Request: ${data.document_name}`,
                `Token: ${data.token}`,
                `Status: ${data.status}`,
                `Company: ${acct.company_name}`,
                `Signer: ${contact.full_name} (${contact.email})`,
                data.description ? `Description: ${data.description}` : "",
                data.signed_at ? `Signed: ${data.signed_at}` : "⏳ Not signed yet",
                ``,
                `👁️ Admin Preview: ${APP_BASE_URL}/sign-document/${data.token}/${data.access_code}?preview=td`,
                `🔗 Client URL: ${APP_BASE_URL}/sign-document/${data.token}/${data.access_code}`,
              ].filter(Boolean).join("\n"),
            }],
          }
        }

        if (account_id) {
          const { data, error } = await supabaseAdmin
            .from("signature_requests")
            .select("token, document_name, status, signed_at, created_at")
            .eq("account_id", account_id)
            .order("created_at", { ascending: false })

          if (error) {
            return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] }
          }

          if (!data?.length) {
            return { content: [{ type: "text" as const, text: "No signature requests for this account" }] }
          }

          const lines = data.map(r =>
            `${r.status === "signed" ? "✅" : "⏳"} ${r.document_name} (${r.token}) — ${r.status}${r.signed_at ? ` on ${r.signed_at.slice(0, 10)}` : ""}`
          )

          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        return { content: [{ type: "text" as const, text: "Provide token or account_id" }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )
}
