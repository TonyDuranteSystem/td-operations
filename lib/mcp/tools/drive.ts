/**
 * Google Drive MCP Tools
 * Search, browse, upload, organize files on the Tony Durante LLC Shared Drive.
 * Uses SA with Domain-Wide Delegation (impersonates support@tonydurante.us).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  searchFiles,
  listFolder,
  getFileMetadata,
  uploadFile,
  updateFileContent,
  renameFile,
  createFolder,
  moveFile,
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
    "Search files and folders on the Tony Durante LLC Shared Drive by name or keyword. Returns file details with links.",
    {
      query: z.string().describe("Search text (matches file/folder names)"),
      mime_type: z.string().optional().describe("Filter by MIME type (e.g. 'application/pdf', 'application/vnd.google-apps.folder')"),
      max_results: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
    },
    async ({ query, mime_type, max_results }) => {
      try {
        const result = (await searchFiles(query, mime_type, max_results)) as { files: DriveFile[] }

        if (!result.files || result.files.length === 0) {
          return {
            content: [{ type: "text" as const, text: `📭 No files found matching "${query}"` }],
          }
        }

        const lines = [
          `🔍 Found ${result.files.length} result(s) for "${query}"`,
          "",
        ]

        for (const f of result.files) {
          const icon = mimeIcon(f.mimeType)
          const size = f.mimeType === "application/vnd.google-apps.folder" ? "" : ` (${formatSize(f.size)})`
          const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""
          lines.push(`${icon} ${f.name}${size}`)
          lines.push(`   📅 Modified: ${modified}`)
          lines.push(`   🔗 ${f.webViewLink || `ID: ${f.id}`}`)
          lines.push("")
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
    "List contents of a folder on the Shared Drive. Shows files and subfolders with size, type, and modification date. Use the Shared Drive root ID '0AOLZHXSfKUMHUk9PVA' to list top-level folders.",
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
    "Get detailed metadata for a file or folder (name, type, size, dates, link, parents).",
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
    "Read the text content of a file (text, CSV, Google Docs/Sheets). Returns the file content as plain text. For binary files (PDFs, images), use drive_get_file_info for metadata instead.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      max_chars: z.number().optional().default(10000).describe("Maximum characters to return (default 10000)"),
    },
    async ({ file_id, max_chars }) => {
      try {
        const content = await downloadFileContent(file_id)
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

  // ═══════════════════════════════════════
  // drive_upload
  // ═══════════════════════════════════════
  server.tool(
    "drive_upload",
    "Upload or overwrite a text-based file on the Shared Drive. If file_id is provided, overwrites the existing file (keeps same ID, creates new version). If not, creates a new file in folder_id. Supports text, CSV, JSON, HTML, Markdown.",
    {
      folder_id: z.string().optional().describe("Parent folder ID for NEW uploads. Required when creating a new file, ignored when overwriting (file_id)."),
      file_id: z.string().optional().describe("Existing file ID to OVERWRITE. If provided, replaces the file content (same ID, new version). If omitted, creates a new file."),
      file_name: z.string().describe("File name with extension (e.g. 'report.csv', 'notes.md'). For overwrites, also renames the file if different."),
      content: z.string().describe("File content (text)"),
      mime_type: z.string().optional().default("text/plain").describe("MIME type (default: text/plain). Common: text/csv, application/json, text/html, text/markdown"),
    },
    async ({ folder_id, file_id, file_name, content, mime_type }) => {
      try {
        let result: DriveFile
        let action: string

        if (file_id) {
          // Overwrite existing file
          result = (await updateFileContent(file_id, content, mime_type || "text/plain", file_name)) as DriveFile
          action = "overwritten"
        } else {
          // Create new file
          if (!folder_id) {
            return {
              content: [{ type: "text" as const, text: `❌ folder_id is required when creating a new file (no file_id provided)` }],
            }
          }
          result = (await uploadFile(folder_id, file_name, content, mime_type || "text/plain")) as DriveFile
          action = "uploaded"
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ File ${action} successfully`,
              "",
              `📄 Name: ${result.name}`,
              `🆔 ID: ${result.id}`,
              `📋 Type: ${result.mimeType}`,
              `🔗 Link: https://drive.google.com/file/d/${result.id}/view`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Upload failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // drive_create_folder
  // ═══════════════════════════════════════
  server.tool(
    "drive_create_folder",
    "Create a new folder on the Shared Drive. Returns the new folder ID.",
    {
      parent_folder_id: z.string().describe("Parent folder ID (use '0AOLZHXSfKUMHUk9PVA' for Shared Drive root)"),
      folder_name: z.string().describe("Name for the new folder"),
    },
    async ({ parent_folder_id, folder_name }) => {
      try {
        const result = (await createFolder(parent_folder_id, folder_name)) as DriveFile

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Folder created successfully`,
              "",
              `📁 Name: ${result.name}`,
              `🆔 ID: ${result.id}`,
              `🔗 Link: https://drive.google.com/drive/folders/${result.id}`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Create folder failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // drive_move
  // ═══════════════════════════════════════
  server.tool(
    "drive_move",
    "Move a file or folder to a different parent folder on the Shared Drive.",
    {
      file_id: z.string().describe("File or folder ID to move"),
      new_parent_id: z.string().describe("Destination folder ID"),
    },
    async ({ file_id, new_parent_id }) => {
      try {
        const result = (await moveFile(file_id, new_parent_id)) as DriveFile

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ File moved successfully`,
              "",
              `📄 Name: ${result.name}`,
              `📂 New location: folder ${new_parent_id}`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Move failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // drive_rename
  // ═══════════════════════════════════════
  server.tool(
    "drive_rename",
    "Rename a file or folder on the Shared Drive. Changes only the name, not the location or content.",
    {
      file_id: z.string().describe("File or folder ID to rename"),
      new_name: z.string().describe("New name for the file/folder (include extension for files)"),
    },
    async ({ file_id, new_name }) => {
      try {
        const result = (await renameFile(file_id, new_name)) as DriveFile

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Renamed successfully`,
              "",
              `📄 New name: ${result.name}`,
              `🆔 ID: ${result.id}`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Rename failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
