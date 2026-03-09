/**
 * Document Classification MCP Tools
 * Classify files from Google Drive based on content (OCR + regex rules).
 *
 * Uses:
 * - DocAI for OCR (scanned PDFs, images)
 * - PyPDF2-equivalent text extraction (via Drive API export for Google Docs)
 * - 40+ classification rules ported from gdrive-file-classifier.py
 *
 * Categories: Company, Contacts, Tax, Banking, Correspondence
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ocrDriveFile } from "@/lib/docai"
import { classifyDocument, classifyByFilename, RULES } from "@/lib/classifier"
import { downloadFileContent, getFileMetadata } from "@/lib/google-drive"

// ─── Helpers ────────────────────────────────────────────────

interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  size?: string
  parents?: string[]
  webViewLink?: string
}

/**
 * Try to extract text from a Drive file.
 * 1. If it's a Google Doc/Sheet, export as text (fast).
 * 2. If it's a text file, download directly (fast).
 * 3. If it's a PDF/image, use Document AI OCR (slower).
 */
export async function extractTextFromFile(
  fileId: string,
): Promise<{ pages: string[]; method: "text" | "ocr" | "filename_only"; fileName: string }> {
  const meta = (await getFileMetadata(fileId)) as DriveFileMeta

  // Google Docs / Sheets — export as text
  if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
    const text = await downloadFileContent(fileId)
    return { pages: [text], method: "text", fileName: meta.name }
  }

  // Text-based files — download directly
  const textMimes = [
    "text/", "application/json", "application/xml",
    "application/csv", "text/csv",
  ]
  if (textMimes.some(m => meta.mimeType.includes(m))) {
    const text = await downloadFileContent(fileId)
    return { pages: [text], method: "text", fileName: meta.name }
  }

  // PDF / Images — use Document AI OCR
  const ocrMimes = [
    "application/pdf",
    "image/tiff", "image/gif", "image/jpeg", "image/png",
    "image/bmp", "image/webp",
  ]
  if (ocrMimes.includes(meta.mimeType)) {
    const result = await ocrDriveFile(fileId)
    return { pages: result.pages, method: "ocr", fileName: meta.name }
  }

  // Unsupported — return filename only for basic classification
  return { pages: [], method: "filename_only", fileName: meta.name }
}

// ─── Tool Registration ──────────────────────────────────────

export function registerClassifyTools(server: McpServer) {

  // ═══════════════════════════════════════
  // classify_document
  // ═══════════════════════════════════════
  server.tool(
    "classify_document",
    "Classify a Google Drive document by auto-extracting text (OCR or direct) and running 40+ rules. Returns document type (W-9, SS-4, Tax Return, etc.), category (Company/Contacts/Tax/Banking/Correspondence), suggested folder, and confidence. For the full pipeline (OCR + classify + store in Supabase), use doc_process_file instead.",
    {
      file_id: z.string().describe("Google Drive file ID to classify"),
    },
    async ({ file_id }) => {
      try {
        const { pages, method, fileName } = await extractTextFromFile(file_id)

        // Try content-based classification first
        let result = pages.length > 0 ? classifyDocument(pages) : null

        // Fallback to filename-based classification
        if (!result) {
          result = classifyByFilename(fileName)
        }

        const lines: string[] = [
          `📄 File: ${fileName}`,
          `🔍 Method: ${method === "ocr" ? "Document AI OCR" : method === "text" ? "Text extraction" : "Filename only"}`,
          "",
        ]

        if (result) {
          lines.push(`✅ Classified as: **${result.type}**`)
          lines.push(`📁 Category: ${result.category}. ${result.categoryName}`)
          lines.push(`📂 Suggested folder: ${result.suggestedFolder}`)
          lines.push(`📊 Confidence: ${result.confidence}`)
          if (result.ruleIndex >= 0) {
            lines.push(`🔧 Rule: #${result.ruleIndex} (${RULES[result.ruleIndex]?.scope || "?"} scope)`)
          }
        } else {
          lines.push(`⚠️ Unclassified — no matching rules found`)
          lines.push(`💡 Consider adding a new classification rule for this document type`)
          if (pages.length > 0) {
            // Show first 500 chars of page 1 for manual review
            const preview = pages[0].slice(0, 500).replace(/\n{3,}/g, "\n\n")
            lines.push("")
            lines.push(`── Page 1 preview (first 500 chars) ──`)
            lines.push(preview)
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Classification failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // classify_text
  // ═══════════════════════════════════════
  server.tool(
    "classify_text",
    "Classify a document from raw text content when you already have the text available. Runs the same 40+ classification rules as classify_document. No file download needed — useful when text was already extracted via OCR or other processing.",
    {
      text: z.string().describe("Document text content. For multi-page documents, separate pages with '\\n---PAGE---\\n'"),
      filename: z.string().optional().describe("Optional filename for fallback classification"),
    },
    async ({ text, filename }) => {
      try {
        // Split into pages if separator present
        const pages = text.includes("\n---PAGE---\n")
          ? text.split("\n---PAGE---\n")
          : [text]

        let result = classifyDocument(pages)

        // Fallback to filename
        if (!result && filename) {
          result = classifyByFilename(filename)
        }

        if (result) {
          return {
            content: [{
              type: "text" as const,
              text: [
                `✅ Classified as: **${result.type}**`,
                `📁 Category: ${result.category}. ${result.categoryName}`,
                `📂 Suggested folder: ${result.suggestedFolder}`,
                `📊 Confidence: ${result.confidence}`,
              ].join("\n"),
            }],
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `⚠️ Unclassified — no matching rules found for this text content`,
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Classification failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // classify_list_rules
  // ═══════════════════════════════════════
  server.tool(
    "classify_list_rules",
    "List all 40+ document classification rules with their patterns, categories, and scopes. Use this to understand what document types can be automatically detected or to debug why a document was classified incorrectly.",
    {
      category: z.number().optional().describe("Filter by category (1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence)"),
    },
    async ({ category }) => {
      try {
        const CATEGORY_NAMES: Record<number, string> = {
          1: "Company", 2: "Contacts", 3: "Tax", 4: "Banking", 5: "Correspondence",
        }

        const filteredRules = category
          ? RULES.filter(r => r.category === category)
          : RULES

        const lines: string[] = [
          `📋 Classification Rules${category ? ` (Category ${category}: ${CATEGORY_NAMES[category]})` : " (All)"}`,
          `Total: ${filteredRules.length} rules`,
          "",
        ]

        for (let i = 0; i < filteredRules.length; i++) {
          const rule = filteredRules[i]
          const globalIndex = RULES.indexOf(rule)
          lines.push(
            `#${globalIndex} | ${rule.type} | Cat ${rule.category} (${CATEGORY_NAMES[rule.category]}) | Scope: ${rule.scope}` +
            (rule.excludes.length > 0 ? ` | ${rule.excludes.length} exclude(s)` : "")
          )
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
