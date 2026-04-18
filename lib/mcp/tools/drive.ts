/**
 * Google Drive MCP Tools
 * Search, browse, upload, organize files on the Tony Durante LLC Shared Drive.
 * Uses SA with Domain-Wide Delegation (impersonates support@tonydurante.us).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { logAction } from "@/lib/mcp/action-log"
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
  uploadBinaryToDrive,
  trashFile,
} from "@/lib/google-drive"
import { getGmailAttachment } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"

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
    "Search files and folders on the Tony Durante LLC Shared Drive by name or keyword. Returns file names, sizes, modification dates, and direct links. Optionally filter by MIME type (e.g. 'application/pdf' for PDFs only). For browsing a known folder, use drive_list_folder instead.",
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
    "Upload a new text file or overwrite an existing one on the Shared Drive. For NEW files: provide folder_id + file_name + content. For OVERWRITING: provide file_id + content (keeps same ID, creates new version). Supports text, CSV, JSON, HTML, Markdown.",
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

        logAction({
          action_type: file_id ? "update" : "create",
          table_name: "drive",
          record_id: result.id,
          summary: `Drive file ${action}: ${result.name}`,
          details: { folder_id, file_id, mime_type },
        })

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
    "Create a new folder on the Shared Drive inside a parent folder. Returns the new folder ID and link. Use '0AOLZHXSfKUMHUk9PVA' for the Shared Drive root as parent.",
    {
      parent_folder_id: z.string().describe("Parent folder ID (use '0AOLZHXSfKUMHUk9PVA' for Shared Drive root)"),
      folder_name: z.string().describe("Name for the new folder"),
    },
    async ({ parent_folder_id, folder_name }) => {
      try {
        const result = (await createFolder(parent_folder_id, folder_name)) as DriveFile

        logAction({
          action_type: "create",
          table_name: "drive",
          record_id: result.id,
          summary: `Created Drive folder: ${result.name}`,
          details: { parent_folder_id },
        })

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
    "Move a file or folder to a different parent folder on the Shared Drive. Provide the file/folder ID and the destination folder ID. The file keeps its name and content.",
    {
      file_id: z.string().describe("File or folder ID to move"),
      new_parent_id: z.string().describe("Destination folder ID"),
    },
    async ({ file_id, new_parent_id }) => {
      try {
        const result = (await moveFile(file_id, new_parent_id)) as DriveFile

        logAction({
          action_type: "update",
          table_name: "drive",
          record_id: file_id,
          summary: `Moved Drive file: ${result.name} to folder ${new_parent_id}`,
        })

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
    "Rename a file or folder on the Shared Drive. Changes only the name — location and content are unchanged. Include the file extension when renaming files (e.g. 'new-name.pdf').",
    {
      file_id: z.string().describe("File or folder ID to rename"),
      new_name: z.string().describe("New name for the file/folder (include extension for files)"),
    },
    async ({ file_id, new_name }) => {
      try {
        const result = (await renameFile(file_id, new_name)) as DriveFile

        logAction({
          action_type: "update",
          table_name: "drive",
          record_id: file_id,
          summary: `Renamed Drive file to: ${result.name}`,
        })

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

  // ═══════════════════════════════════════
  // drive_upload_file
  // ═══════════════════════════════════════
  server.tool(
    "drive_upload_file",
    "Upload a binary file (PDF, image, etc.) to Google Drive from Gmail attachments, external URLs, or Supabase Storage. Use this for ANY non-text file that drive_upload cannot handle. Workflow for Gmail: 1) gmail_read to get message_id + attachment details, 2) call this with source='gmail'. Workflow for URL: call with source='url' and the direct download link. Workflow for Supabase Storage: call with source='supabase_storage' and storage_path (path inside the bucket, e.g. '{token}/passport_owner_file.pdf'). Default bucket: onboarding-uploads. Max file size: ~4MB.",
    {
      source: z.enum(["gmail", "url", "supabase_storage"]).describe("Where to get the file: 'gmail' = Gmail attachment, 'url' = download from URL, 'supabase_storage' = Supabase Storage bucket"),
      folder_id: z.string().describe("Target Google Drive folder ID"),
      filename: z.string().optional().describe("Override filename (optional — auto-detected from source if omitted)"),
      // Gmail source params
      message_id: z.string().optional().describe("Gmail message ID (required when source='gmail')"),
      attachment_id: z.string().optional().describe("Gmail attachment ID from message parts (required when source='gmail')"),
      // URL source params
      url: z.string().optional().describe("Direct download URL (required when source='url')"),
      // Supabase Storage source params
      storage_path: z.string().optional().describe("File path inside the Supabase Storage bucket (required when source='supabase_storage'). E.g. '{token}/passport_owner_file.pdf'"),
      storage_bucket: z.string().optional().describe("Supabase Storage bucket name (default: 'onboarding-uploads'). Only needed if file is in a different bucket."),
    },
    async ({ source, folder_id, filename, message_id, attachment_id, url, storage_path, storage_bucket }) => {
      try {
        let fileData: Buffer
        let finalFilename: string
        let mimeType: string

        if (source === "gmail") {
          // ── Gmail Attachment ──
          if (!message_id || !attachment_id) {
            return {
              content: [{ type: "text" as const, text: "❌ message_id and attachment_id are required when source='gmail'. Use gmail_read first to get these values." }],
            }
          }

          // Get attachment binary
          const { data } = await getGmailAttachment(message_id, attachment_id)
          fileData = data

          // Get filename from message metadata if not provided
          if (!filename) {
            // Fetch message to get attachment filename
            const { gmailGet } = await import("@/lib/gmail")
            const msg = (await gmailGet(`/messages/${message_id}`, { format: "full" })) as {
              payload: {
                parts?: Array<{
                  filename?: string
                  mimeType: string
                  body?: { attachmentId?: string }
                }>
              }
            }
            const part = msg.payload.parts?.find(
              (p) => p.body?.attachmentId === attachment_id
            )
            finalFilename = part?.filename || `attachment-${Date.now()}`
            mimeType = part?.mimeType || "application/octet-stream"
          } else {
            finalFilename = filename
            mimeType = guessMimeType(filename)
          }

        } else if (source === "url") {
          // ── URL Download ──
          if (!url) {
            return {
              content: [{ type: "text" as const, text: "❌ url is required when source='url'" }],
            }
          }

          const res = await fetch(url)
          if (!res.ok) {
            return {
              content: [{ type: "text" as const, text: `❌ Failed to download from URL: ${res.status} ${res.statusText}` }],
            }
          }

          const arrayBuffer = await res.arrayBuffer()
          fileData = Buffer.from(arrayBuffer)

          // Detect filename from URL or Content-Disposition header
          const disposition = res.headers.get("content-disposition")
          if (filename) {
            finalFilename = filename
          } else if (disposition) {
            const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i)
            finalFilename = match ? decodeURIComponent(match[1]) : `download-${Date.now()}`
          } else {
            const urlPath = new URL(url).pathname
            finalFilename = urlPath.split("/").pop() || `download-${Date.now()}`
          }

          mimeType = res.headers.get("content-type") || guessMimeType(finalFilename)

        } else if (source === "supabase_storage") {
          // ── Supabase Storage Download ──
          if (!storage_path) {
            return {
              content: [{ type: "text" as const, text: "❌ storage_path is required when source='supabase_storage'. Provide the file path inside the bucket (e.g. '{token}/passport_owner_file.pdf')." }],
            }
          }

          const bucket = storage_bucket || "onboarding-uploads"
          const cleanPath = storage_path.replace(/^\/+/, "")

          const { data: blob, error: dlErr } = await supabaseAdmin.storage
            .from(bucket)
            .download(cleanPath)

          if (dlErr || !blob) {
            return {
              content: [{ type: "text" as const, text: `❌ Failed to download from Supabase Storage (${bucket}/${cleanPath}): ${dlErr?.message || "no data returned"}` }],
            }
          }

          const arrayBuffer = await blob.arrayBuffer()
          fileData = Buffer.from(arrayBuffer)

          // Derive filename from storage path if not provided
          finalFilename = filename || cleanPath.split("/").pop() || `storage-file-${Date.now()}`
          mimeType = blob.type || guessMimeType(finalFilename)

        } else {
          return {
            content: [{ type: "text" as const, text: "❌ Invalid source. Use 'gmail', 'url', or 'supabase_storage'." }],
          }
        }

        // Check size (~4MB limit for Vercel)
        if (fileData.length > 4 * 1024 * 1024) {
          return {
            content: [{ type: "text" as const, text: `❌ File too large (${formatSize(fileData.length)}). Max supported: ~4MB. Upload manually via Google Drive.` }],
          }
        }

        // Upload to Drive
        const result = (await uploadBinaryToDrive(finalFilename, fileData, mimeType, folder_id)) as DriveFile

        logAction({
          action_type: "create",
          table_name: "drive",
          record_id: result.id,
          summary: `Uploaded binary file: ${result.name} (${formatSize(fileData.length)})`,
          details: { source, folder_id, mime_type: mimeType },
        })

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ File uploaded successfully`,
              "",
              `📄 Name: ${result.name}`,
              `📦 Size: ${formatSize(fileData.length)}`,
              `📋 Type: ${mimeType}`,
              `🆔 ID: ${result.id}`,
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
  // drive_delete (trash)
  // ═══════════════════════════════════════
  server.tool(
    "drive_delete",
    "Move a file or folder to the trash on the Shared Drive. Uses soft-delete — the file can be restored from trash within 30 days. For permanent deletion, use the Google Drive web UI. Use drive_search or drive_list_folder to find the file ID first. Pass dry_run=true to preview the target before committing — P3.7 safety control.",
    {
      file_id: z.string().describe("File or folder ID to trash"),
      dry_run: z.boolean().optional().describe("If true, returns target metadata without trashing. Default: false."),
    },
    async ({ file_id, dry_run }) => {
      try {
        if (dry_run) {
          const meta = (await getFileMetadata(file_id)) as { name?: string; mimeType?: string; size?: string; modifiedTime?: string; parents?: string[] }
          return {
            content: [{
              type: "text" as const,
              text: `🔍 Dry run — drive_delete\n• File: ${meta.name ?? file_id}\n• Type: ${meta.mimeType ?? "unknown"}\n• Size: ${meta.size ?? "—"}\n• Modified: ${meta.modifiedTime ?? "—"}\n\nAction: move to Drive trash (recoverable 30 days). Pass dry_run=false to commit.`,
            }],
          }
        }

        const result = await trashFile(file_id)

        logAction({
          action_type: "delete",
          table_name: "drive",
          record_id: file_id,
          summary: `Trashed Drive file: ${result.name || file_id}`,
        })

        return {
          content: [{
            type: "text" as const,
            text: `🗑️ Trashed: ${result.name || file_id}\nFile moved to trash. Can be restored within 30 days.`,
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Trash failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}

// ─── Utility ────────────────────────────────────────────────

function guessMimeType(filename: string): string {
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
