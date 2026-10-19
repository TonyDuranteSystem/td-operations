/**
 * Google Drive MCP Tools
 * READ-ONLY: search, browse and read files on the Tony Durante LLC Shared Drive (the archive).
 * Drive writes were removed on 2026-10-18 (Stop Drive, dev job 264bb882) — new files go to CRM storage.
 * Uses SA with Domain-Wide Delegation (impersonates support@tonydurante.us).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { callerIsOwner } from "@/lib/mcp/auth-context"
import {
  searchFiles,
  searchOwnerDriveFiles,
  listFolder,
  getFileMetadata,
  downloadFileContent,
} from "@/lib/google-drive"

// ─── Helpers ────────────────────────────────────────────────

function formatSize(bytes: number | string | undefined): string {
  if (!bytes) return "—"
  const b = typeof bytes === "string" ? parseInt(bytes, 10) : bytes
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function mimeIcon(mimeType: string): string {
  if (mimeType === "application/vnd.google-apps.folder") return "📁"
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) return "📊"
  if (mimeType.includes("document") || mimeType.includes("word")) return "📄"
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "📽️"
  if (mimeType.includes("pdf")) return "📕"
  if (mimeType.includes("image")) return "🖼️"
  if (mimeType.includes("video")) return "🎬"
  if (mimeType.includes("audio")) return "🎵"
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return "📦"
  if (mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("text")) return "📝"
  return "📎"
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  createdTime?: string
  modifiedTime?: string
  webViewLink?: string
  parents?: string[]
  description?: string
}

// ─── Tool Registration ──────────────────────────────────────

export function registerDriveTools(server: McpServer) {

  // ═══════════════════════════════════════
  // drive_search
  // ═══════════════════════════════════════
  server.tool(
    "drive_search",
    "Search files and folders by name or keyword. Searches the Tony Durante LLC Shared Drive (client documents). When the caller is the owner, ALSO searches the owner's own private accounting folder in his personal Drive, reported as a clearly separated second section. Returns file names, sizes, modification dates, and direct links. Optionally filter by MIME type (e.g. 'application/pdf' for PDFs only). For browsing a known folder, use drive_list_folder instead.",
    {
      query: z.string().describe("Search text (matches file/folder names)"),
      mime_type: z.string().optional().describe("Filter by MIME type (e.g. 'application/pdf', 'application/vnd.google-apps.folder')"),
      max_results: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
    },
    async ({ query, mime_type, max_results }) => {
      try {
        const result = (await searchFiles(query, mime_type, max_results)) as { files: DriveFile[] }

        // The owner's own accounting folder is a SEPARATE identity and a separate
        // section — never merged into the client results, so a search for a
        // client's statement can't bury the operator in his own paperwork.
        // A failure here must not take down normal client search, which is what
        // every other caller depends on.
        let ownerFiles: DriveFile[] = []
        let ownerError: string | null = null
        if (callerIsOwner()) {
          try {
            const ownerResult = (await searchOwnerDriveFiles(query, mime_type, max_results)) as { files?: DriveFile[] }
            ownerFiles = ownerResult.files || []
          } catch (e) {
            ownerError = e instanceof Error ? e.message : String(e)
          }
        }

        const sharedFiles = result.files || []
        if (sharedFiles.length === 0 && ownerFiles.length === 0 && !ownerError) {
          return {
            content: [{ type: "text" as const, text: `📭 No files found matching "${query}"` }],
          }
        }

        const renderFile = (f: DriveFile) => {
          const icon = mimeIcon(f.mimeType)
          const size = f.mimeType === "application/vnd.google-apps.folder" ? "" : ` (${formatSize(f.size)})`
          const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""
          return [
            `${icon} ${f.name}${size}`,
            `   📅 Modified: ${modified}`,
            `   🔗 ${f.webViewLink || `ID: ${f.id}`}`,
            "",
          ]
        }

        const lines = [
          `🔍 Company Shared Drive — ${sharedFiles.length} result(s) for "${query}"`,
          "",
        ]
        for (const f of sharedFiles) lines.push(...renderFile(f))

        if (ownerFiles.length > 0) {
          lines.push(`🔒 Your personal accounting folder — ${ownerFiles.length} result(s)`, "")
          for (const f of ownerFiles) lines.push(...renderFile(f))
        }
        if (ownerError) {
          lines.push(`⚠️ Your personal accounting folder could not be searched: ${ownerError}`, "")
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Search failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // drive_list_folder
  // ═══════════════════════════════════════
  server.tool(
    "drive_list_folder",
    "List contents of a specific folder on the Shared Drive by folder ID. Shows subfolders and files with size, type, and modification date. Use '0AOLZHXSfKUMHUk9PVA' for the Shared Drive root. Returns folder IDs for navigating deeper. For searching by name, use drive_search instead.",
    {
      folder_id: z.string().describe("Google Drive folder ID (use '0AOLZHXSfKUMHUk9PVA' for Shared Drive root)"),
      max_results: z.number().optional().default(50).describe("Max results (default 50, max 100)"),
    },
    async ({ folder_id, max_results }) => {
      try {
        const result = (await listFolder(folder_id, max_results)) as { files: DriveFile[] }

        if (!result.files || result.files.length === 0) {
          return {
            content: [{ type: "text" as const, text: "📭 Folder is empty." }],
          }
        }

        // Separate folders and files
        const folders = result.files.filter(f => f.mimeType === "application/vnd.google-apps.folder")
        const files = result.files.filter(f => f.mimeType !== "application/vnd.google-apps.folder")

        const lines = [
          `📂 Folder contents (${result.files.length} items)`,
          "",
        ]

        if (folders.length > 0) {
          lines.push(`── Folders (${folders.length}) ──`)
          for (const f of folders) {
            lines.push(`📁 ${f.name}  [ID: ${f.id}]`)
          }
          lines.push("")
        }

        if (files.length > 0) {
          lines.push(`── Files (${files.length}) ──`)
          for (const f of files) {
            const icon = mimeIcon(f.mimeType)
            const size = formatSize(f.size)
            const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""
            lines.push(`${icon} ${f.name}  (${size}, ${modified})  [ID: ${f.id}]`)
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ List folder failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // drive_get_file_info
  // ═══════════════════════════════════════
  server.tool(
    "drive_get_file_info",
    "Get detailed metadata for a file or folder by ID: name, MIME type, size, created/modified dates, description, parent folder ID, and web view link. Use this to inspect a specific file before reading or processing it.",
    {
      file_id: z.string().describe("Google Drive file or folder ID"),
    },
    async ({ file_id }) => {
      try {
        const f = (await getFileMetadata(file_id)) as DriveFile
        const icon = mimeIcon(f.mimeType)

        const lines = [
          `${icon} ${f.name}`,
          "",
          `📋 Type: ${f.mimeType}`,
          `📦 Size: ${formatSize(f.size)}`,
          `📅 Created: ${f.createdTime ? new Date(f.createdTime).toLocaleString() : "—"}`,
          `📅 Modified: ${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : "—"}`,
          `📝 Description: ${f.description || "(none)"}`,
          `🔗 Link: ${f.webViewLink || "—"}`,
          `📂 Parent(s): ${f.parents?.join(", ") || "—"}`,
          `🆔 ID: ${f.id}`,
        ]

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Get file info failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // drive_read_file
  // ═══════════════════════════════════════
  server.tool(
    "drive_read_file",
    "Read the text content of a Drive file (text, CSV, Google Docs/Sheets exported as text). Returns plain text, truncated at max_chars. For PDFs and images, use docai_ocr_file for OCR text extraction instead. For metadata only, use drive_get_file_info.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      max_chars: z.number().optional().default(10000).describe("Maximum characters to return (default 10000)"),
    },
    async ({ file_id, max_chars }) => {
      try {
        let content: string
        const { classifyPointer, openDocument } = await import("@/lib/documents/open-document")
        if (classifyPointer(file_id) === "drive") {
          content = await downloadFileContent(file_id)
        } else {
          // A file in the new CRM storage: read it as text only if it is a text type; otherwise point to OCR.
          const d = await openDocument(file_id)
          if (!/^text\/|json|csv|xml/.test(d.mimeType || "")) {
            return { content: [{ type: "text" as const, text: `This stored file (${d.mimeType || "unknown type"}) isn't plain text. Use docai_ocr_file to read it.` }] }
          }
          content = d.buffer.toString("utf8")
        }
        const truncated = content.length > (max_chars || 10000)
        const text = truncated ? content.slice(0, max_chars || 10000) : content

        return {
          content: [{
            type: "text" as const,
            text: truncated
              ? `${text}\n\n⚠️ Truncated at ${max_chars} chars (total: ${content.length} chars)`
              : text,
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Read file failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )


}

// ─── Utility ────────────────────────────────────────────────

export function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase()
  const map: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    csv: "text/csv",
    txt: "text/plain",
    html: "text/html",
    json: "application/json",
  }
  return map[ext || ""] || "application/octet-stream"
}
