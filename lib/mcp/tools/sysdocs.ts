/**
 * System Documentation Tools — Read/write system_docs on Supabase
 *
 * system_docs stores operational documentation:
 * - Milestones & Roadmap
 * - Session Context (read at start of every session)
 * - System Issues to Fix
 * - Credenziali & Chiavi API
 * - Episodic session logs (doc_type='ops_session')
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
    "List all system documentation entries with slug, title, type, and last updated timestamp. Use the slug with sysdoc_read to get full content. Key documents: 'session-context' (lean quick-ref), 'project-state' (milestones), 'tech-stack' (architecture), 'platform-credentials'.",
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
    "Read a system document by slug. Key documents: 'session-context' (lean quick-ref — MUST read at start of every session), 'project-state' (milestones + tool inventory), 'tech-stack' (architecture + identifiers), 'platform-credentials' (API keys + config), 'system-issues-to-fix' (known bugs). Returns full Markdown content.",
    {
      slug: z.string().describe("Document slug (e.g. 'session-context', 'project-state', 'tech-stack', 'platform-credentials')"),
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
  // sysdoc_create — Create a new system document
  // ═══════════════════════════════════════
  server.tool(
    "sysdoc_create",
    "Create a new system document. Use for episodic session logs (doc_type='ops_session') or new reference docs (doc_type='markdown'). Slug must be unique. For session logs, use slug format 'ops-YYYY-MM-DD' or 'ops-YYYY-MM-DD-topic'.",
    {
      slug: z.string().describe("Unique slug (e.g. 'ops-2026-03-09', 'ops-2026-03-09-hubspot-sync')"),
      title: z.string().describe("Document title"),
      content: z.string().describe("Full content (Markdown)"),
      doc_type: z.enum(["markdown", "ops_session"]).default("ops_session").describe("Document type: 'ops_session' for session logs, 'markdown' for reference docs"),
    },
    async ({ slug, title, content, doc_type }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("system_docs")
          .insert({ slug, title, content, doc_type, updated_at: new Date().toISOString() })
          .select("slug, title, doc_type, updated_at")
          .single()

        if (error) {
          if (error.code === "23505") {
            return { content: [{ type: "text" as const, text: `❌ Slug '${slug}' already exists. Use sysdoc_update to modify it.` }] }
          }
          throw error
        }

        return {
          content: [{
            type: "text" as const,
            text: `✅ Document created: ${data.slug} (${data.doc_type}) at ${data.updated_at}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ sysdoc_create error: ${err.message}` }] }
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
