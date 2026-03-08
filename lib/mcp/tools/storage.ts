/**
 * Supabase Storage MCP Tools
 *
 * Provides file operations on the td-operations bucket in Supabase Storage.
 * Enables Claude on any device (iPad, iPhone, Mac) to list, read, upload,
 * and delete files without needing credentials — they stay server-side.
 *
 * IN-LINE SYNC: All files written to Supabase Storage are automatically
 * mirrored to Google Drive (My Drive > TD Operations/) preserving the
 * folder structure. Supabase Storage = source of truth, Drive = mirror.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  updateFileContent,
  uploadFileMyDrive,
  listFolderAnyDrive,
  ensureDrivePath,
} from "@/lib/google-drive"

const BUCKET = "td-operations"

// Google Drive folder ID for "TD Operations" in My Drive (support@tonydurante.us)
// All Supabase Storage content is mirrored here
const DRIVE_TD_OPERATIONS_FOLDER = (process.env.DRIVE_TD_OPERATIONS_FOLDER || "").trim()

/**
 * Sync a file to Google Drive after writing to Supabase Storage.
 * Best-effort: if Drive sync fails, the Supabase write is still successful.
 * Mirrors the full Supabase Storage path into My Drive > TD Operations/.
 */
async function syncToDrive(
  filePath: string,
  content: string,
  mimeType: string,
): Promise<string | null> {
  // Skip sync if no Drive folder configured
  if (!DRIVE_TD_OPERATIONS_FOLDER) return null

  try {
    const segments = filePath.split("/")
    const fileName = segments.pop()!

    // Ensure the parent folder path exists on Drive
    // e.g. "Claude Memory/INDEX.md" → ensure "Claude Memory" folder exists
    const parentFolderId = segments.length > 0
      ? await ensureDrivePath(DRIVE_TD_OPERATIONS_FOLDER, segments)
      : DRIVE_TD_OPERATIONS_FOLDER

    // Check if file already exists in the target folder
    const folderContents = (await listFolderAnyDrive(parentFolderId, 200)) as {
      files?: { id: string; name: string; mimeType: string }[]
    }
    const match = folderContents.files?.find(
      (f) => f.name === fileName,
    )

    if (match) {
      await updateFileContent(match.id, content, mimeType)
      return `updated ${match.id}`
    } else {
      const result = (await uploadFileMyDrive(
        parentFolderId,
        fileName,
        content,
        mimeType,
      )) as { id: string }
      return `created ${result.id}`
    }
  } catch (err: any) {
    console.error(`[Drive sync] Failed for ${filePath}: ${err.message}`)
    return `sync-error: ${err.message}`
  }
}

export function registerStorageTools(server: McpServer) {
  // ─── storage_list ────────────────────────────────────────
  server.tool(
    "storage_list",
    "List files and folders in Supabase Storage (td-operations bucket). Use path '' for root.",
    {
      path: z
        .string()
        .optional()
        .default("")
        .describe("Folder path inside the bucket (e.g. 'SOP' or 'CRM Project'). Empty for root."),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Max files to return"),
    },
    async ({ path, limit }) => {
      try {
        const folderPath = path?.replace(/^\/+|\/+$/g, "") || ""
        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET)
          .list(folderPath || undefined, {
            limit: Math.min(limit || 100, 500),
            sortBy: { column: "name", order: "asc" },
          })

        if (error) {
          return {
            content: [{ type: "text" as const, text: `❌ Error: ${error.message}` }],
          }
        }

        if (!data || data.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `📭 No files found in "${folderPath || "/"}"`,
              },
            ],
          }
        }

        const folders = data.filter((f) => f.id === null)
        const files = data.filter((f) => f.id !== null)

        const lines = [`📂 ${folderPath || "/"} — ${data.length} items\n`]

        if (folders.length > 0) {
          lines.push("── Folders ──")
          for (const f of folders) {
            lines.push(`  📁 ${f.name}/`)
          }
          lines.push("")
        }

        if (files.length > 0) {
          lines.push("── Files ──")
          for (const f of files) {
            const kb = f.metadata?.size
              ? `${(Number(f.metadata.size) / 1024).toFixed(1)} KB`
              : ""
            const updated = f.updated_at
              ? new Date(f.updated_at).toLocaleDateString()
              : ""
            lines.push(`  📄 ${f.name}  ${kb}  ${updated}`)
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ storage_list failed: ${e.message}` }],
        }
      }
    }
  )

  // ─── storage_read ────────────────────────────────────────
  server.tool(
    "storage_read",
    "Read/download a text file from Supabase Storage. Returns the file content as text. Works for .md, .txt, .json, .csv, .ts, .js, .html, .xml and similar text files.",
    {
      path: z
        .string()
        .describe("Full path to the file inside the bucket (e.g. 'SOP/Standard Operating Procedures.md')"),
    },
    async ({ path }) => {
      try {
        const filePath = path.replace(/^\/+/, "")
        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET)
          .download(filePath)

        if (error) {
          return {
            content: [{ type: "text" as const, text: `❌ Error: ${error.message}` }],
          }
        }

        const text = await data.text()

        if (text.length > 50000) {
          return {
            content: [
              {
                type: "text" as const,
                text: `📄 ${filePath} (${(text.length / 1024).toFixed(1)} KB — truncated to 50K chars)\n\n${text.substring(0, 50000)}\n\n... [TRUNCATED]`,
              },
            ],
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `📄 ${filePath} (${(text.length / 1024).toFixed(1)} KB)\n\n${text}`,
            },
          ],
        }
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ storage_read failed: ${e.message}` }],
        }
      }
    }
  )

  // ─── storage_write ───────────────────────────────────────
  server.tool(
    "storage_write",
    "Upload or overwrite a text file in Supabase Storage. Creates parent folders automatically.",
    {
      path: z
        .string()
        .describe("Full path for the file (e.g. 'SOP/new-procedure.md')"),
      content: z
        .string()
        .describe("Text content to write"),
      content_type: z
        .string()
        .optional()
        .default("text/plain")
        .describe("MIME type (default: text/plain). Use text/markdown for .md files."),
    },
    async ({ path, content, content_type }) => {
      try {
        const filePath = path.replace(/^\/+/, "")

        // Auto-detect content type from extension
        let ct = content_type || "text/plain"
        if (ct === "text/plain") {
          const ext = filePath.split(".").pop()?.toLowerCase()
          const mimeMap: Record<string, string> = {
            md: "text/markdown",
            json: "application/json",
            csv: "text/csv",
            html: "text/html",
            xml: "application/xml",
            ts: "text/typescript",
            js: "text/javascript",
          }
          if (ext && mimeMap[ext]) ct = mimeMap[ext]
        }

        const { error } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(filePath, content, {
            contentType: ct,
            upsert: true,
          })

        if (error) {
          return {
            content: [{ type: "text" as const, text: `❌ Upload error: ${error.message}` }],
          }
        }

        // In-line sync to Google Drive for Claude Memory files
        const driveSync = await syncToDrive(filePath, content, ct)
        const syncMsg = driveSync
          ? driveSync.startsWith("sync-error")
            ? ` ⚠️ Drive sync failed: ${driveSync}`
            : ` 📂 Drive sync: ${driveSync}`
          : ""

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Written: ${filePath} (${(content.length / 1024).toFixed(1)} KB)${syncMsg}`,
            },
          ],
        }
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ storage_write failed: ${e.message}` }],
        }
      }
    }
  )

  // ─── storage_delete ──────────────────────────────────────
  server.tool(
    "storage_delete",
    "Delete one or more files from Supabase Storage.",
    {
      paths: z
        .array(z.string())
        .describe("Array of file paths to delete (e.g. ['SOP/old-file.md'])"),
    },
    async ({ paths }) => {
      try {
        const cleanPaths = paths.map((p) => p.replace(/^\/+/, ""))

        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET)
          .remove(cleanPaths)

        if (error) {
          return {
            content: [{ type: "text" as const, text: `❌ Delete error: ${error.message}` }],
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `🗑️ Deleted ${data?.length || 0} file(s): ${cleanPaths.join(", ")}`,
            },
          ],
        }
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ storage_delete failed: ${e.message}` }],
        }
      }
    }
  )

  // ─── storage_move ────────────────────────────────────────
  server.tool(
    "storage_move",
    "Move or rename a file within Supabase Storage.",
    {
      from_path: z.string().describe("Current file path"),
      to_path: z.string().describe("New file path"),
    },
    async ({ from_path, to_path }) => {
      try {
        const from = from_path.replace(/^\/+/, "")
        const to = to_path.replace(/^\/+/, "")

        const { error } = await supabaseAdmin.storage
          .from(BUCKET)
          .move(from, to)

        if (error) {
          return {
            content: [{ type: "text" as const, text: `❌ Move error: ${error.message}` }],
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Moved: ${from} → ${to}`,
            },
          ],
        }
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ storage_move failed: ${e.message}` }],
        }
      }
    }
  )
}
