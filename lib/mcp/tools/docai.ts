/**
 * Document AI MCP Tools
 * OCR files from Google Drive using Google Document AI.
 * Supports PDFs and images. Returns extracted text (full + per-page).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ocrDriveFile } from "@/lib/docai"

export function registerDocaiTools(server: McpServer) {

  // ═══════════════════════════════════════
  // docai_ocr_file
  // ═══════════════════════════════════════
  server.tool(
    "docai_ocr_file",
    "Extract text from a PDF or image on Google Drive using Google Document AI OCR. Returns full text + per-page breakdown. Supports: PDF, TIFF, GIF, JPEG, PNG, BMP, WEBP. Max 15MB. Use this when you need raw text from scanned documents. For the full processing pipeline (OCR + classify + store), use doc_process_file instead.",
    {
      file_id: z.string().describe("Google Drive file ID of the document to OCR"),
      max_chars: z.number().optional().default(20000).describe("Maximum characters to return (default 20000). Full text is always processed; this limits the response."),
      page_mode: z.enum(["full", "per_page", "page1"]).optional().default("full").describe("Output mode: 'full' = full text concatenated, 'per_page' = text separated by page, 'page1' = only first page text (fastest for classification)"),
    },
    async ({ file_id, max_chars, page_mode }) => {
      try {
        const result = await ocrDriveFile(file_id)

        const lines: string[] = [
          `📄 OCR Result: ${result.fileName}`,
          `📊 Pages: ${result.pageCount} | Confidence: ${(result.confidence * 100).toFixed(1)}% | Type: ${result.mimeType}`,
          "",
        ]

        const mode = page_mode || "full"
        const limit = max_chars || 20000

        if (mode === "page1") {
          const page1 = result.pages[0] || "(no text extracted)"
          const truncated = page1.length > limit
          lines.push("── Page 1 ──")
          lines.push(truncated ? page1.slice(0, limit) : page1)
          if (truncated) {
            lines.push(`\n⚠️ Truncated at ${limit} chars (page 1 total: ${page1.length} chars)`)
          }
        } else if (mode === "per_page") {
          let totalChars = 0
          for (let i = 0; i < result.pages.length; i++) {
            const pageText = result.pages[i]
            lines.push(`── Page ${i + 1} ──`)
            const remaining = limit - totalChars
            if (remaining <= 0) {
              lines.push(`⚠️ Truncated: ${result.pageCount - i} more page(s) not shown`)
              break
            }
            if (pageText.length > remaining) {
              lines.push(pageText.slice(0, remaining))
              lines.push(`\n⚠️ Truncated at ${limit} total chars (${result.pageCount - i - 1} more pages)`)
              break
            }
            lines.push(pageText)
            totalChars += pageText.length
            lines.push("")
          }
        } else {
          // "full" mode
          const text = result.fullText
          const truncated = text.length > limit
          lines.push(truncated ? text.slice(0, limit) : text)
          if (truncated) {
            lines.push(`\n⚠️ Truncated at ${limit} chars (total: ${text.length} chars)`)
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ OCR failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
