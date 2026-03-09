/**
 * System Documentation Tools — Read/write system_docs on Supabase
 *
 * system_docs stores operational documentation:
 * - Milestones & Roadmap
 * - System Issues to Fix
 * - Credenziali & Chiavi API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerSysdocTools(server: McpServer) {

  // ═══════════════════════════════════════
  // sysdoc_list — List all system documents
  // ═══════════════════════════════════════
  server.tool(
    "sysdoc_list",
    "List all system documentation entries with slug, title, type, and last updated timestamp. Use the slug with sysdoc_read to get full content. Key documents: 'session-context', 'platform-credentials', 'system-issues-to-fix', 'milestones'.",
    {},
    async () => {
      try {
        const { data, error } = await supabaseAdmin
          .from("system_docs")
          .select("slug, title, doc_type, updated_at")
          .order("title")

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(data || [], null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ sysdoc_list error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sysdoc_read — Read full document content
  // ═══════════════════════════════════════
  server.tool(
    "sysdoc_read",
    "Read a system document by slug. Key documents: 'session-context' (current state + milestones — MUST read at start of every operational session), 'platform-credentials' (API keys + config), 'system-issues-to-fix' (known bugs), 'milestones' (roadmap). Returns full Markdown content.",
    {
      slug: z.string().describe("Document slug (e.g. 'milestones', 'system-issues-to-fix', 'platform-credentials')"),
    },
    async ({ slug }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("system_docs")
          .select("*")
          .eq("slug", slug)
          .single()

        if (error) throw error
        if (!data) return { content: [{ type: "text" as const, text: `❌ Document not found: ${slug}` }] }

        return {
          content: [{
            type: "text" as const,
            text: `# ${data.title}\n_Last updated: ${data.updated_at}_\n\n${data.content}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ sysdoc_read error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sysdoc_update — Update document content
  // ═══════════════════════════════════════
  server.tool(
    "sysdoc_update",
    "Update the content and/or title of an existing system document by slug. Only provided fields are changed. The updated_at timestamp is set automatically. Use sysdoc_read first to get current content before making changes.",
    {
      slug: z.string().describe("Document slug to update"),
      content: z.string().optional().describe("New full content (Markdown)"),
      title: z.string().optional().describe("New title"),
    },
    async ({ slug, content, title }) => {
      try {
        const updates: Record<string, any> = { updated_at: new Date().toISOString() }
        if (content !== undefined) updates.content = content
        if (title !== undefined) updates.title = title

        const { data, error } = await supabaseAdmin
          .from("system_docs")
          .update(updates)
          .eq("slug", slug)
          .select("slug, title, updated_at")
          .single()

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: `✅ Document ${slug} updated at ${data.updated_at}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ sysdoc_update error: ${err.message}` }] }
      }
    }
  )
}
