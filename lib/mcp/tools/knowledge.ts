/**
 * Knowledge Base Tools — Search and manage knowledge articles + approved responses
 *
 * knowledge_articles: Business rules, pricing, banking, tone guidelines (35 articles)
 * approved_responses: Pre-approved client response templates (66 responses)
 *
 * Together these form the "Antonio Brain" — Claude learns how Antonio
 * reasons and responds to client situations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"

// Canonical Master Rules article — business rules source of truth.
// Writes are frozen by default; require override_master_rules=true to modify.
// UUID verified via SQL query on 2026-04-09 against knowledge_articles.
// Title: "MASTER RULES — Fixed Business Rules Reference", category: "Business Rules".
const MASTER_RULES_ARTICLE_ID = "370347b6-cfa7-486e-a757-e2acce70e15d"

export function registerKnowledgeTools(server: McpServer) {

  // ═══════════════════════════════════════
  // kb_search — Search across articles + responses
  // ═══════════════════════════════════════
  server.tool(
    "kb_search",
    "Search the knowledge base for business rules, pricing, banking info, and approved client response templates. Matches title, content, and tags. ALWAYS search here BEFORE answering client-facing questions to check for approved responses or established business rules. Covers knowledge_articles (35 rules) and approved_responses (66 templates).",
    {
      query: z.string().describe("Search text (matches title, content, tags — case-insensitive)"),
      source: z.enum(["all", "articles", "responses"]).optional().default("all").describe("Search in articles, responses, or both"),
      category: z.string().optional().describe("Filter by category (e.g. Banking, Pricing, Business Rules)"),
      limit: z.number().optional().default(10).describe("Max results per source"),
    },
    async ({ query, source, category, limit }) => {
      try {
        const results: any = {}

        if (source === "all" || source === "articles") {
          let q = supabaseAdmin
            .from("knowledge_articles")
            .select("id, title, category, content")
            .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
            .limit(Math.min(limit || 10, 50))

          if (category) q = q.eq("category", category)

          const { data } = await q
          results.articles = data || []
        }

        if (source === "all" || source === "responses") {
          let q = supabaseAdmin
            .from("approved_responses")
            .select("id, title, category, service_type, language, response_text, tags, notes, usage_count")
            .or(`title.ilike.%${query}%,response_text.ilike.%${query}%`)
            .limit(Math.min(limit || 10, 50))

          if (category) q = q.eq("category", category)

          const { data } = await q
          results.responses = data || []
        }

        const totalHits = (results.articles?.length || 0) + (results.responses?.length || 0)

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ total_hits: totalHits, ...results }, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ kb_search error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // kb_get — Get a specific article or response
  // ═══════════════════════════════════════
  server.tool(
    "kb_get",
    "Get the full content of a knowledge article or approved response by UUID. Use after kb_search to retrieve complete details. For approved_responses, automatically increments the usage counter.",
    {
      id: z.string().uuid().describe("Article or response UUID"),
      source: z.enum(["article", "response"]).describe("Whether this is a knowledge_article or approved_response"),
    },
    async ({ id, source }) => {
      try {
        const table = source === "article" ? "knowledge_articles" : "approved_responses"
        const { data, error } = await supabaseAdmin
          .from(table)
          .select("*")
          .eq("id", id)
          .single()

        if (error) throw error

        // Increment usage count for responses
        if (source === "response") {
          await supabaseAdmin
            .from("approved_responses")
            .update({
              usage_count: ((data as Record<string, unknown>).usage_count as number || 0) + 1,
              last_used_date: new Date().toISOString().split("T")[0],
            })
            .eq("id", id)
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ kb_get error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // kb_create — Create new article or response
  // ═══════════════════════════════════════
  server.tool(
    "kb_create",
    "Create a new knowledge article or approved response template. Use this to codify new business rules or save approved client responses for future reuse. For responses, include reasoning in the 'notes' field (Antonio Brain learning).",
    {
      source: z.enum(["article", "response"]).describe("Create in knowledge_articles or approved_responses"),
      title: z.string().describe("Title/name"),
      category: z.string().describe("Category (e.g. Banking, Pricing, Business Rules, Tone Guidelines)"),
      content: z.string().describe("Full content text"),
      // Response-specific fields
      service_type: z.string().optional().describe("(responses only) Service type this applies to"),
      language: z.string().optional().describe("(responses only) Language: en or it"),
      tags: z.array(z.string()).optional().describe("Tags for searchability"),
      notes: z.string().optional().describe("(responses only) Internal notes / reasoning behind this response (Antonio Brain)"),
    },
    async ({ source, title, category, content, service_type, language, tags, notes }) => {
      try {
        if (source === "article") {
          const { data, error } = await supabaseAdmin
            .from("knowledge_articles")
            .insert({ title, category, content })
            .select("id, title, category")
            .single()
          if (error) throw error
          logAction({
            action_type: "create",
            table_name: "knowledge_articles",
            record_id: data.id,
            summary: `Created KB article: ${data.title}`,
            details: { category },
          })
          return { content: [{ type: "text" as const, text: `✅ Article created: ${data.title} (${data.id})` }] }
        } else {
          const { data, error } = await supabaseAdmin
            .from("approved_responses")
            .insert({
              title,
              category,
              response_text: content,
              service_type: service_type as never,
              language: language || "en",
              tags,
              notes,
              usage_count: 0,
            })
            .select("id, title, category")
            .single()
          if (error) throw error
          logAction({
            action_type: "create",
            table_name: "approved_responses",
            record_id: data.id,
            summary: `Created KB response: ${data.title}`,
            details: { category, service_type, language },
          })
          return { content: [{ type: "text" as const, text: `✅ Response created: ${data.title} (${data.id})` }] }
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ kb_create error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // kb_update — Update article or response
  // ═══════════════════════════════════════
  server.tool(
    "kb_update",
    "Update an existing knowledge article or approved response by UUID. Only provided fields are changed. Use kb_search first to find the record ID. HARD FREEZE: the canonical Master Rules article (370347b6-cfa7-486e-a757-e2acce70e15d) is protected against writes — any attempt to update it is rejected unless override_master_rules=true is set explicitly. This prevents accidental corruption of the business rules source of truth.",
    {
      id: z.string().uuid().describe("Record UUID"),
      source: z.enum(["article", "response"]).describe("Table to update"),
      updates: z.record(z.string(), z.any()).describe("Fields to update (e.g. {content: 'new text', category: 'Banking'})"),
      override_master_rules: z.boolean().optional().default(false).describe("Explicit opt-in to modify the canonical Master Rules article (370347b6-cfa7-486e-a757-e2acce70e15d). Must be literally true to unlock the write on that specific record. Has no effect on any other article or any response. Use ONLY with explicit user authorization naming the Master Rules article."),
    },
    async ({ id, source, updates, override_master_rules }) => {
      try {
        // ─── HARD FREEZE: Master Rules article requires explicit override ───
        // This check runs BEFORE the table resolution and BEFORE the DB call.
        // No partial bypass: the flag must be literally `true` (not "true", not 1).
        if (
          source === "article" &&
          id === MASTER_RULES_ARTICLE_ID &&
          override_master_rules !== true
        ) {
          return {
            content: [{
              type: "text" as const,
              text: `🛑 BLOCKED: Article ${MASTER_RULES_ARTICLE_ID} ("MASTER RULES — Fixed Business Rules Reference") is the canonical business rules source of truth and is frozen against writes. To modify this specific record, re-invoke kb_update with override_master_rules=true explicitly. This freeze has no partial bypass — the flag must be the boolean true, and only affects this single article ID.\n\nThe record was NOT updated.`,
            }],
          }
        }

        const table = source === "article" ? "knowledge_articles" : "approved_responses"

        // Map 'content' to correct field name for responses
        if (source === "response" && updates.content) {
          updates.response_text = updates.content
          delete updates.content
        }

        const { data, error } = await supabaseAdmin
          .from(table)
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("id, title, category, updated_at")
          .single()

        if (error) throw error

        logAction({
          action_type: "update",
          table_name: table,
          record_id: data.id,
          summary: `Updated KB ${source}: ${data.title}`,
          details: { fields: Object.keys(updates) },
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ ${source === "article" ? "Article" : "Response"} updated: ${data.title}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ kb_update error: ${err.message}` }] }
      }
    }
  )
}
