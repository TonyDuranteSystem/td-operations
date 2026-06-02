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

/**
 * Defense-in-depth redaction for agent-facing document bodies. Replaces obvious
 * secret-like and PII-like patterns with [REDACTED]. This is a SAFETY NET only —
 * the primary gate is agent_readable + human body review. Docs that genuinely
 * need redaction should be cleaned before being flagged agent_readable, not
 * relied on this pass.
 */
export function redactSensitive(input: string): { text: string; redacted: boolean } {
  const patterns: RegExp[] = [
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
    /sb_(?:secret|publishable)_[A-Za-z0-9]+/g,                       // Supabase keys
    /sk-[A-Za-z0-9]{16,}/g,                                          // OpenAI-style keys
    /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,                               // bearer tokens
    /\b\d{2}-\d{7}\b/g,                                              // EIN
    /\b\d{3}-\d{2}-\d{4}\b/g,                                        // SSN / ITIN
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,           // email
  ]
  let text = input
  let redacted = false
  for (const re of patterns) {
    const replaced = text.replace(re, "[REDACTED]")
    if (replaced !== text) redacted = true
    text = replaced
  }
  return { text, redacted }
}

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

  // ═══════════════════════════════════════
  // sysdoc_read_allowed — Filtered, agent-safe document read
  // ═══════════════════════════════════════
  server.tool(
    "sysdoc_read_allowed",
    "Read a system document body ONLY if it has been explicitly cleared for agent access (agent_readable = true). Returns a uniform 'Document not available to the agent.' for any slug that is not cleared OR does not exist — it never reveals whether a slug exists. Use sysdoc_list to discover slugs. This is the ONLY approved document-body read path for restricted agents; raw sysdoc_read is not exposed to them.",
    {
      slug: z.string().describe("Document slug to read (returns content only if agent_readable=true)"),
    },
    async ({ slug }) => {
      const REFUSAL = "Document not available to the agent."
      const logRead = async (allowed: boolean, redaction_applied: boolean, caller: string) => {
        try {
          await supabaseAdmin.from("sysdoc_read_log").insert({ slug, allowed, caller, redaction_applied })
        } catch {
          /* audit-log failure must never change the read result */
        }
      }
      try {
        const { data, error } = await supabaseAdmin
          .from("system_docs")
          .select("title, content, updated_at")
          .eq("slug", slug)
          .eq("agent_readable", true)
          .maybeSingle()

        if (error) throw error

        // Blocked OR nonexistent → identical refusal (no existence leak)
        if (!data) {
          await logRead(false, false, "mcp:sysdoc_read_allowed")
          return { content: [{ type: "text" as const, text: REFUSAL }] }
        }

        // Defense-in-depth: redact obvious secret/PII patterns even on cleared docs
        const { text: safeBody, redacted } = redactSensitive(data.content || "")
        await logRead(true, redacted, "mcp:sysdoc_read_allowed")

        return {
          content: [{
            type: "text" as const,
            text: `# ${data.title}\n_source: sysdoc:${slug}_\n_Last updated: ${data.updated_at}_\n\n${safeBody}`,
          }],
        }
      } catch {
        // Fail closed — never leak error detail or document existence
        await logRead(false, false, "mcp:sysdoc_read_allowed:error")
        return { content: [{ type: "text" as const, text: REFUSAL }] }
      }
    }
  )
}
