/**
 * Document Intelligence MCP Tools
 * Pipeline: Google Drive file -> OCR -> Classify -> Store in Supabase
 *
 * Tools:
 *   doc_process_file      — Full pipeline for a single file
 *   doc_process_folder    — Batch process all files in a folder (flat)
 *   doc_process_client    — Recursive: process entire client folder tree (subfolders 1-5)
 *   doc_bulk_process      — Process all docs for a CRM account (auto-resolves Drive folder)
 *   doc_search            — Search processed documents
 *   doc_list              — List documents by account/category
 *   doc_get               — Get full document details
 *   doc_stats             — Document statistics
 *   doc_map_folders       — Link orphan documents to CRM accounts via Drive folder ancestry
 *   doc_compliance_check  — Check required vs present docs for a client
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { classifyDocument, classifyByFilename } from "@/lib/classifier"
import { getFileMetadata, listFolder } from "@/lib/google-drive"
import { extractTextFromFile } from "@/lib/mcp/tools/classify"
import { logAction } from "@/lib/mcp/action-log"

// ─── Constants ──────────────────────────────────────────────

const MAX_OCR_TEXT = 50_000 // Truncate stored OCR text
const BATCH_MAX_FILES = 20
const BATCH_TIMEOUT_MS = 50_000 // Stop 10s before Vercel 60s limit

// Supported MIME types for processing
const PROCESSABLE_MIMES = [
  "application/pdf",
  "image/tiff", "image/gif", "image/jpeg", "image/png",
  "image/bmp", "image/webp",
  "text/plain", "text/csv", "text/html",
  "application/json", "application/xml",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
]

// ─── Helpers ────────────────────────────────────────────────

interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  size?: string
  webViewLink?: string
  parents?: string[]
}

/**
 * Process a single file: extract text -> classify -> upsert into documents table.
 */
async function processFile(
  fileId: string,
  accountId?: string,
  accountName?: string,
): Promise<{
  success: boolean
  fileName: string
  type?: string
  category?: string
  confidence?: string
  status: string
  error?: string
}> {
  try {
    // 1. Get metadata
    const meta = (await getFileMetadata(fileId)) as DriveFileMeta

    // 2. Extract text (OCR or direct)
    const { pages, method, fileName } = await extractTextFromFile(fileId)

    // 3. Classify
    let classification = pages.length > 0
      ? classifyDocument(pages)
      : null

    // Fallback to filename classification
    if (!classification && fileName) {
      classification = classifyByFilename(fileName)
    }

    // 4. Lookup document_type_id if classified
    let documentTypeId: number | null = null
    if (classification) {
      const { data: dtRow } = await supabaseAdmin
        .from("document_types")
        .select("id")
        .eq("type_name", classification.type)
        .single()
      if (dtRow) documentTypeId = dtRow.id
    }

    // 5. If account_id provided but no name, look it up
    if (accountId && !accountName) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name")
        .eq("id", accountId)
        .single()
      if (acc) accountName = acc.company_name
    }

    // 6. Prepare OCR text (truncated)
    const ocrText = pages.join("\n---PAGE BREAK---\n").slice(0, MAX_OCR_TEXT)

    // 7. Upsert document record
    const status = classification ? "classified" : (pages.length > 0 ? "unclassified" : "error")

    const { error: dbError } = await supabaseAdmin
      .from("documents")
      .upsert({
        drive_file_id: fileId,
        file_name: fileName,
        mime_type: meta.mimeType,
        file_size: meta.size ? parseInt(meta.size, 10) : null,
        drive_link: meta.webViewLink || null,
        drive_parent_folder_id: meta.parents?.[0] || null,
        document_type_id: documentTypeId,
        document_type_name: classification?.type || null,
        category: classification?.category || null,
        category_name: classification?.categoryName || null,
        confidence: classification?.confidence || null,
        ocr_text: ocrText || null,
        ocr_page_count: pages.length || null,
        account_id: accountId || null,
        account_name: accountName || null,
        processed_at: new Date().toISOString(),
        status,
        error_message: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "drive_file_id" })

    if (dbError) throw new Error(`DB error: ${dbError.message}`)

    return {
      success: true,
      fileName,
      type: classification?.type,
      category: classification?.categoryName,
      confidence: classification?.confidence,
      status,
    }
  } catch (error) {
    // Store error in documents table
    try {
      const meta = (await getFileMetadata(fileId)) as DriveFileMeta
      await supabaseAdmin.from("documents").upsert({
        drive_file_id: fileId,
        file_name: meta.name,
        mime_type: meta.mimeType,
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "drive_file_id" })
    } catch {
      // Ignore secondary errors
    }

    return {
      success: false,
      fileName: fileId,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Recursively collect all processable files from a folder and its subfolders.
 */
async function collectFilesRecursive(
  folderId: string,
  maxDepth: number = 3,
  depth: number = 0,
): Promise<DriveFileMeta[]> {
  if (depth > maxDepth) return []

  const result = (await listFolder(folderId, 200)) as { files: DriveFileMeta[] }
  if (!result.files || result.files.length === 0) return []

  const files: DriveFileMeta[] = []
  const subfolders: DriveFileMeta[] = []

  for (const item of result.files) {
    if (item.mimeType === "application/vnd.google-apps.folder") {
      subfolders.push(item)
    } else if (PROCESSABLE_MIMES.some(m => item.mimeType.startsWith(m) || item.mimeType === m)) {
      files.push(item)
    }
  }

  // Recurse into subfolders
  for (const sub of subfolders) {
    const subFiles = await collectFilesRecursive(sub.id, maxDepth, depth + 1)
    files.push(...subFiles)
  }

  return files
}

// ─── Tool Registration ──────────────────────────────────────

export function registerDocTools(server: McpServer) {

  // ═══════════════════════════════════════
  // doc_process_file
  // ═══════════════════════════════════════
  server.tool(
    "doc_process_file",
    "Process a single Google Drive file: extracts text via OCR (docai_ocr_file), classifies document type and category using AI rules (classify_document), and stores the result in Supabase documents table. Returns document type, category, confidence score, and status. Provide account_id to link the document to a CRM client. For batch processing an entire folder, use doc_process_folder or doc_bulk_process instead.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      account_id: z.string().uuid().optional().describe("Link document to this client account (UUID)"),
    },
    async ({ file_id, account_id }) => {
      try {
        const result = await processFile(file_id, account_id)

        if (result.success) {
          logAction({
            action_type: "process",
            table_name: "documents",
            record_id: file_id,
            account_id: account_id,
            summary: `Processed file: ${result.fileName} → ${result.type || "unclassified"}`,
            details: { type: result.type, category: result.category, confidence: result.confidence, status: result.status },
          })

          const lines = [
            `✅ Processed: ${result.fileName}`,
            "",
            result.type ? `📋 Type: ${result.type}` : "⚠️ Unclassified",
            result.category ? `📁 Category: ${result.category}` : "",
            result.confidence ? `📊 Confidence: ${result.confidence}` : "",
            `📌 Status: ${result.status}`,
          ].filter(Boolean)

          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        return {
          content: [{ type: "text" as const, text: `❌ Processing failed for ${result.fileName}: ${result.error}` }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Process file failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_process_folder
  // ═══════════════════════════════════════
  server.tool(
    "doc_process_folder",
    "Batch-process all supported files in a single Google Drive folder (non-recursive). Extracts text, classifies, and stores each document in Supabase. Skips already-processed files by default. Max 20 files per call (60s timeout). Returns per-file results with success/fail counts. For recursive folder processing (subfolders), use doc_process_client. For auto-resolving a client's folder from CRM, use doc_bulk_process instead.",
    {
      folder_id: z.string().describe("Google Drive folder ID"),
      account_id: z.string().uuid().optional().describe("Link all documents to this client account (UUID)"),
      skip_existing: z.boolean().optional().default(true).describe("Skip files already in documents table (default: true)"),
    },
    async ({ folder_id, account_id, skip_existing }) => {
      try {
        const startTime = Date.now()

        // 1. List folder contents
        const result = (await listFolder(folder_id, 100)) as { files: DriveFileMeta[] }
        if (!result.files || result.files.length === 0) {
          return { content: [{ type: "text" as const, text: "📭 Folder is empty." }] }
        }

        // 2. Filter to processable files
        const files = result.files.filter(f =>
          PROCESSABLE_MIMES.some(m => f.mimeType.startsWith(m) || f.mimeType === m)
        )

        if (files.length === 0) {
          return { content: [{ type: "text" as const, text: `📭 No processable files found (${result.files.length} items in folder, none are PDF/image/text).` }] }
        }

        // 3. Check existing if skip_existing
        let toProcess = files
        if (skip_existing) {
          const fileIds = files.map(f => f.id)
          const { data: existing } = await supabaseAdmin
            .from("documents")
            .select("drive_file_id")
            .in("drive_file_id", fileIds)

          const existingIds = new Set(existing?.map(e => e.drive_file_id) || [])
          toProcess = files.filter(f => !existingIds.has(f.id))
        }

        if (toProcess.length === 0) {
          return { content: [{ type: "text" as const, text: `✅ All ${files.length} files already processed. Nothing to do.` }] }
        }

        // 4. Resolve account name once
        let accountName: string | undefined
        if (account_id) {
          const { data: acc } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", account_id)
            .single()
          if (acc) accountName = acc.company_name
        }

        // 5. Process files (with timeout safety)
        const batch = toProcess.slice(0, BATCH_MAX_FILES)
        const results: Array<{ fileName: string; status: string; type?: string; error?: string }> = []
        let timedOut = false

        for (const file of batch) {
          // Check timeout
          if (Date.now() - startTime > BATCH_TIMEOUT_MS) {
            timedOut = true
            break
          }

          const r = await processFile(file.id, account_id, accountName)
          results.push({
            fileName: r.fileName,
            status: r.status,
            type: r.type,
            error: r.error,
          })
        }

        // 6. Summary
        const classified = results.filter(r => r.status === "classified").length
        const unclassified = results.filter(r => r.status === "unclassified").length
        const errors = results.filter(r => r.status === "error").length
        const skipped = files.length - toProcess.length

        const lines = [
          `📊 Batch Processing Complete`,
          "",
          `📁 Folder: ${folder_id}`,
          `📄 Total files: ${result.files.length} | Processable: ${files.length} | Skipped (existing): ${skipped}`,
          `✅ Classified: ${classified} | ⚠️ Unclassified: ${unclassified} | ❌ Errors: ${errors}`,
          timedOut ? `⏱️ Timeout reached — ${batch.length - results.length} files remaining` : "",
          toProcess.length > BATCH_MAX_FILES ? `📌 Batch limit: processed ${batch.length}/${toProcess.length} (run again for remaining)` : "",
          "",
          "── Details ──",
        ]

        for (const r of results) {
          const icon = r.status === "classified" ? "✅" : r.status === "unclassified" ? "⚠️" : "❌"
          lines.push(`${icon} ${r.fileName} → ${r.type || r.status}${r.error ? ` (${r.error.slice(0, 80)})` : ""}`)
        }

        if (results.length > 0) {
          logAction({
            action_type: "process",
            table_name: "documents",
            account_id: account_id,
            summary: `Batch processed folder ${folder_id}: ${classified} classified, ${unclassified} unclassified, ${errors} errors`,
            details: { folder_id, total: results.length, classified, unclassified, errors, skipped },
          })
        }

        return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Batch processing failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_process_client
  // ═══════════════════════════════════════
  server.tool(
    "doc_process_client",
    "Recursively process all documents in a client's Google Drive folder tree (walks subfolders up to 5 levels deep). Extracts text, classifies, and stores each in Supabase. Links all documents to the CRM account if account_id provided. Max 20 files per call — run again for remaining. For a simpler approach that auto-resolves the Drive folder from CRM, use doc_bulk_process instead.",
    {
      folder_id: z.string().describe("Client's root Google Drive folder ID (parent of subfolders 1-5)"),
      account_id: z.string().uuid().optional().describe("CRM account UUID to link documents to"),
      skip_existing: z.boolean().optional().default(true).describe("Skip already-processed files (default: true)"),
    },
    async ({ folder_id, account_id, skip_existing }) => {
      try {
        const startTime = Date.now()

        // 1. Recursively collect all files from client folder tree
        const allFiles = await collectFilesRecursive(folder_id, 3)

        if (allFiles.length === 0) {
          return { content: [{ type: "text" as const, text: "📭 No processable files found in client folder tree." }] }
        }

        // 2. Check existing if skip_existing
        let toProcess = allFiles
        if (skip_existing) {
          const fileIds = allFiles.map(f => f.id)
          // Query in chunks of 50 (Supabase IN limit)
          const existingIds = new Set<string>()
          for (let i = 0; i < fileIds.length; i += 50) {
            const chunk = fileIds.slice(i, i + 50)
            const { data: existing } = await supabaseAdmin
              .from("documents")
              .select("drive_file_id")
              .in("drive_file_id", chunk)
            existing?.forEach(e => existingIds.add(e.drive_file_id))
          }
          toProcess = allFiles.filter(f => !existingIds.has(f.id))
        }

        if (toProcess.length === 0) {
          return { content: [{ type: "text" as const, text: `✅ All ${allFiles.length} files already processed. Nothing to do.` }] }
        }

        // 3. Resolve account name once
        let accountName: string | undefined
        if (account_id) {
          const { data: acc } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", account_id)
            .single()
          if (acc) accountName = acc.company_name
        }

        // 4. Process files (with timeout + batch limit)
        const batch = toProcess.slice(0, BATCH_MAX_FILES)
        const results: Array<{ fileName: string; status: string; type?: string; error?: string }> = []
        let timedOut = false

        for (const file of batch) {
          if (Date.now() - startTime > BATCH_TIMEOUT_MS) {
            timedOut = true
            break
          }
          const r = await processFile(file.id, account_id, accountName)
          results.push({ fileName: r.fileName, status: r.status, type: r.type, error: r.error })
        }

        // 5. Summary
        const classified = results.filter(r => r.status === "classified").length
        const unclassified = results.filter(r => r.status === "unclassified").length
        const errors = results.filter(r => r.status === "error").length
        const skipped = allFiles.length - toProcess.length
        const remaining = toProcess.length - results.length

        const lines = [
          `📊 Client Folder Processing Complete`,
          accountName ? `👤 Account: ${accountName}` : "",
          "",
          `📄 Total files found: ${allFiles.length} | Skipped (existing): ${skipped} | Processed: ${results.length}`,
          `✅ Classified: ${classified} | ⚠️ Unclassified: ${unclassified} | ❌ Errors: ${errors}`,
          timedOut ? `⏱️ Timeout reached — ${remaining} files remaining (run again)` : "",
          remaining > 0 && !timedOut ? `📌 Batch limit: ${remaining} files remaining (run again)` : "",
          "",
          "── Details ──",
        ]

        for (const r of results) {
          const icon = r.status === "classified" ? "✅" : r.status === "unclassified" ? "⚠️" : "❌"
          lines.push(`${icon} ${r.fileName} → ${r.type || r.status}${r.error ? ` (${r.error.slice(0, 80)})` : ""}`)
        }

        if (results.length > 0) {
          logAction({
            action_type: "process",
            table_name: "documents",
            account_id: account_id,
            summary: `Client folder processed ${folder_id}: ${classified} classified, ${unclassified} unclassified, ${errors} errors`,
            details: { folder_id, total: results.length, classified, unclassified, errors, skipped, remaining },
          })
        }

        return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Client processing failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_search
  // ═══════════════════════════════════════
  server.tool(
    "doc_search",
    "Search the processed documents table in Supabase by file name, document type, category, account, or processing status. Returns matching documents with type, category, confidence, account name, processing date, and Drive link. Categories: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence. Use doc_get with the document ID to retrieve full details including OCR text.",
    {
      query: z.string().optional().describe("Search text (matches file_name or document_type_name, case-insensitive)"),
      category: z.number().optional().describe("Filter by category: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence"),
      document_type: z.string().optional().describe("Filter by exact document type name (e.g. 'Tax Return', 'Passport')"),
      account_id: z.string().uuid().optional().describe("Filter by client account UUID"),
      status: z.enum(["pending", "processed", "classified", "unclassified", "error"]).optional().describe("Filter by processing status"),
      limit: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
    },
    async ({ query, category, document_type, account_id, status, limit }) => {
      try {
        let q = supabaseAdmin
          .from("documents")
          .select("id, drive_file_id, file_name, document_type_name, category, category_name, confidence, status, account_name, processed_at, drive_link")
          .order("processed_at", { ascending: false, nullsFirst: false })
          .limit(Math.min(limit || 25, 100))

        if (query) q = q.or(`file_name.ilike.%${query}%,document_type_name.ilike.%${query}%`)
        if (category) q = q.eq("category", category)
        if (document_type) q = q.eq("document_type_name", document_type)
        if (account_id) q = q.eq("account_id", account_id)
        if (status) q = q.eq("status", status)

        const { data, error } = await q

        if (error) {
          return { content: [{ type: "text" as const, text: `❌ Search error: ${error.message}` }] }
        }

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "📭 No documents found matching criteria." }] }
        }

        const lines = [`🔍 Found ${data.length} document(s)`, ""]

        for (const doc of data) {
          const icon = doc.status === "classified" ? "✅" : doc.status === "unclassified" ? "⚠️" : "❌"
          lines.push(`${icon} ${doc.file_name}`)
          if (doc.document_type_name) lines.push(`   📋 Type: ${doc.document_type_name} (${doc.category_name}) [${doc.confidence}]`)
          if (doc.account_name) lines.push(`   👤 Account: ${doc.account_name}`)
          if (doc.processed_at) lines.push(`   📅 Processed: ${new Date(doc.processed_at).toLocaleString("it-IT")}`)
          if (doc.drive_link) lines.push(`   🔗 ${doc.drive_link}`)
          lines.push(`   🆔 ${doc.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Search failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_list
  // ═══════════════════════════════════════
  server.tool(
    "doc_list",
    "List processed documents filtered by account, category, or status. Sorted by most recently processed first. Returns file name, document type, category, confidence, and account name. Use this to browse documents for a specific client or category without a search query. For text-based searching, use doc_search instead.",
    {
      account_id: z.string().uuid().optional().describe("Filter by client account UUID"),
      category: z.number().optional().describe("Filter by category: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence"),
      status: z.enum(["pending", "processed", "classified", "unclassified", "error"]).optional().describe("Filter by status"),
      limit: z.number().optional().default(50).describe("Max results (default 50, max 200)"),
    },
    async ({ account_id, category, status, limit }) => {
      try {
        let q = supabaseAdmin
          .from("documents")
          .select("id, file_name, document_type_name, category_name, confidence, status, account_name, drive_file_id")
          .order("processed_at", { ascending: false, nullsFirst: false })
          .limit(Math.min(limit || 50, 200))

        if (account_id) q = q.eq("account_id", account_id)
        if (category) q = q.eq("category", category)
        if (status) q = q.eq("status", status)

        const { data, error } = await q

        if (error) {
          return { content: [{ type: "text" as const, text: `❌ List error: ${error.message}` }] }
        }

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "📭 No documents found." }] }
        }

        const lines = [`📄 Documents (${data.length})`, ""]

        for (const doc of data) {
          const icon = doc.status === "classified" ? "✅" : doc.status === "unclassified" ? "⚠️" : "❌"
          const type = doc.document_type_name ? `[${doc.document_type_name}]` : `[${doc.status}]`
          const acct = doc.account_name ? ` — ${doc.account_name}` : ""
          lines.push(`${icon} ${doc.file_name} ${type}${acct}`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ List failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_get
  // ═══════════════════════════════════════
  server.tool(
    "doc_get",
    "Get full details of a single processed document including OCR-extracted text, classification, confidence, account link, and Drive metadata. Lookup by document UUID (from doc_search or doc_list) or by Google Drive file ID. Use this to read the actual content of a processed document.",
    {
      id: z.string().optional().describe("Document UUID (from doc_search/doc_list)"),
      drive_file_id: z.string().optional().describe("Google Drive file ID"),
    },
    async ({ id, drive_file_id }) => {
      try {
        if (!id && !drive_file_id) {
          return { content: [{ type: "text" as const, text: "❌ Provide either 'id' or 'drive_file_id'" }] }
        }

        let q = supabaseAdmin.from("documents").select("*")
        if (id) q = q.eq("id", id)
        else q = q.eq("drive_file_id", drive_file_id!)

        const { data, error } = await q.single()

        if (error || !data) {
          return { content: [{ type: "text" as const, text: `❌ Document not found: ${error?.message || "no match"}` }] }
        }

        const lines = [
          `📄 ${data.file_name}`,
          "",
          `📋 Type: ${data.document_type_name || "(unclassified)"}`,
          `📁 Category: ${data.category_name || "—"} (${data.category || "—"})`,
          `📊 Confidence: ${data.confidence || "—"}`,
          `📌 Status: ${data.status}`,
          "",
          `👤 Account: ${data.account_name || "(none)"}`,
          `🆔 Account ID: ${data.account_id || "—"}`,
          "",
          `📋 MIME: ${data.mime_type}`,
          `📦 Size: ${data.file_size ? `${(data.file_size / 1024).toFixed(1)} KB` : "—"}`,
          `📄 OCR Pages: ${data.ocr_page_count || "—"}`,
          `📊 OCR Confidence: ${data.ocr_confidence ? `${(data.ocr_confidence * 100).toFixed(1)}%` : "—"}`,
          "",
          `📅 Processed: ${data.processed_at ? new Date(data.processed_at).toLocaleString("it-IT") : "—"}`,
          `📅 Created: ${new Date(data.created_at).toLocaleString("it-IT")}`,
          `🔗 Drive: ${data.drive_link || `ID: ${data.drive_file_id}`}`,
          `🆔 Doc ID: ${data.id}`,
        ]

        if (data.error_message) {
          lines.push("", `❌ Error: ${data.error_message}`)
        }

        if (data.ocr_text) {
          const preview = data.ocr_text.slice(0, 2000)
          const truncated = data.ocr_text.length > 2000
          lines.push(
            "",
            "── OCR Text Preview ──",
            preview,
            truncated ? `\n⚠️ Showing 2000/${data.ocr_text.length} chars` : "",
          )
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Get document failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_stats
  // ═══════════════════════════════════════
  server.tool(
    "doc_stats",
    "Get aggregate document processing statistics: total count, breakdown by category (Company/Contacts/Tax/Banking/Correspondence), top document types, and status distribution (classified/unclassified/error). Optionally filter by a specific account to see that client's document stats. Use this for reporting and overview — for individual documents, use doc_search or doc_list.",
    {
      account_id: z.string().uuid().optional().describe("Filter stats for a specific client account"),
    },
    async ({ account_id }) => {
      try {
        // Total count
        let totalQ = supabaseAdmin.from("documents").select("id", { count: "exact", head: true })
        if (account_id) totalQ = totalQ.eq("account_id", account_id)
        const { count: total } = await totalQ

        // By status
        const statusCounts: Record<string, number> = {}
        for (const s of ["classified", "unclassified", "error", "pending"]) {
          let sq = supabaseAdmin.from("documents").select("id", { count: "exact", head: true }).eq("status", s)
          if (account_id) sq = sq.eq("account_id", account_id)
          const { count } = await sq
          if (count && count > 0) statusCounts[s] = count
        }

        // By category
        let catQ = supabaseAdmin.from("documents").select("category, category_name").not("category", "is", null)
        if (account_id) catQ = catQ.eq("account_id", account_id)
        const { data: catData } = await catQ

        const categoryCounts: Record<string, number> = {}
        if (catData) {
          for (const row of catData) {
            const key = `${row.category}. ${row.category_name}`
            categoryCounts[key] = (categoryCounts[key] || 0) + 1
          }
        }

        // Top types
        let typeQ = supabaseAdmin.from("documents").select("document_type_name").not("document_type_name", "is", null)
        if (account_id) typeQ = typeQ.eq("account_id", account_id)
        const { data: typeData } = await typeQ

        const typeCounts: Record<string, number> = {}
        if (typeData) {
          for (const row of typeData) {
            typeCounts[row.document_type_name] = (typeCounts[row.document_type_name] || 0) + 1
          }
        }
        const topTypes = Object.entries(typeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)

        // Build output
        const lines = [
          `📊 Document Statistics${account_id ? " (filtered by account)" : ""}`,
          "",
          `📄 Total documents: ${total || 0}`,
          "",
          "── By Status ──",
          ...Object.entries(statusCounts).map(([s, c]) => {
            const icon = s === "classified" ? "✅" : s === "unclassified" ? "⚠️" : s === "error" ? "❌" : "⏳"
            return `${icon} ${s}: ${c}`
          }),
          "",
          "── By Category ──",
          ...Object.entries(categoryCounts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cat, c]) => `📁 ${cat}: ${c}`),
          "",
          "── Top Document Types ──",
          ...topTypes.map(([t, c]) => `📋 ${t}: ${c}`),
        ]

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Stats failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_map_folders — Link orphan documents to CRM accounts via Drive folder ancestry
  // ═══════════════════════════════════════
  server.tool(
    "doc_map_folders",
    "Link orphan documents (missing account_id) to CRM accounts by matching their Google Drive parent folder against accounts.drive_folder_id. Walks up to 3 levels of parent folders to find a match. Use dry_run=true first to preview which documents would be linked. Run this after doc_process_folder or doc_mass_process to clean up unlinked documents.",
    {
      dry_run: z.boolean().optional().default(false).describe("If true, show matches without updating (default: false)"),
    },
    async ({ dry_run }) => {
      try {
        // 1. Get all accounts with drive_folder_id
        const { data: accounts } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, drive_folder_id")
          .not("drive_folder_id", "is", null)

        if (!accounts || accounts.length === 0) {
          return { content: [{ type: "text" as const, text: "⚠️ No accounts have drive_folder_id set." }] }
        }

        // Build folder→account lookup map
        const folderToAccount = new Map<string, { id: string; name: string }>()
        for (const acc of accounts) {
          if (acc.drive_folder_id) {
            folderToAccount.set(acc.drive_folder_id, { id: acc.id, name: acc.company_name })
          }
        }

        // 2. Get orphan documents (no account_id)
        const { data: orphans } = await supabaseAdmin
          .from("documents")
          .select("id, file_name, drive_file_id, drive_parent_folder_id")
          .is("account_id", null)

        if (!orphans || orphans.length === 0) {
          return { content: [{ type: "text" as const, text: "✅ No orphan documents to link." }] }
        }

        // 3. For each orphan, walk up parent folders to find account match
        const matches: Array<{ docId: string; fileName: string; accountId: string; accountName: string }> = []
        const noMatch: string[] = []

        // Cache parent folder lookups to avoid repeated API calls
        const parentCache = new Map<string, string | null>()

        for (const doc of orphans) {
          let currentFolderId = doc.drive_parent_folder_id
          let matched = false

          // Walk up to 3 levels of parent folders
          for (let level = 0; level < 4 && currentFolderId; level++) {
            // Check if this folder matches an account
            const account = folderToAccount.get(currentFolderId)
            if (account) {
              matches.push({
                docId: doc.id,
                fileName: doc.file_name,
                accountId: account.id,
                accountName: account.name,
              })
              matched = true
              break
            }

            // Get parent of current folder (with cache)
            if (parentCache.has(currentFolderId)) {
              currentFolderId = parentCache.get(currentFolderId) || null
            } else {
              try {
                const meta = (await getFileMetadata(currentFolderId)) as { parents?: string[] }
                const parent = meta.parents?.[0] || null
                parentCache.set(currentFolderId, parent)
                currentFolderId = parent
              } catch {
                parentCache.set(currentFolderId, null)
                currentFolderId = null
              }
            }
          }

          if (!matched) {
            noMatch.push(doc.file_name)
          }
        }

        // 4. Update documents if not dry_run
        if (!dry_run && matches.length > 0) {
          for (const m of matches) {
            await supabaseAdmin
              .from("documents")
              .update({
                account_id: m.accountId,
                account_name: m.accountName,
                updated_at: new Date().toISOString(),
              })
              .eq("id", m.docId)
          }

          logAction({
            action_type: "update",
            table_name: "documents",
            summary: `Mapped ${matches.length} orphan documents to accounts`,
            details: { matched: matches.length, no_match: noMatch.length, orphans: orphans.length },
          })
        }

        // 5. Build output
        const lines = [
          `🔗 Document ↔ Account Mapping${dry_run ? " (DRY RUN)" : ""}`,
          "",
          `📄 Orphan documents: ${orphans.length}`,
          `✅ Matched: ${matches.length}`,
          `❌ No match: ${noMatch.length}`,
          "",
        ]

        if (matches.length > 0) {
          lines.push("── Matches ──")
          // Group by account
          const byAccount: Record<string, string[]> = {}
          for (const m of matches) {
            if (!byAccount[m.accountName]) byAccount[m.accountName] = []
            byAccount[m.accountName].push(m.fileName)
          }
          for (const acct of Object.keys(byAccount)) {
            const files = byAccount[acct]
            lines.push(`👤 ${acct} (${files.length} docs)`)
            for (const f of files) {
              lines.push(`   📄 ${f}`)
            }
          }
        }

        if (noMatch.length > 0) {
          lines.push("", "── No Match ──")
          for (const f of noMatch) {
            lines.push(`   ❓ ${f}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Mapping failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_compliance_check — Check required vs present documents for a client
  // ═══════════════════════════════════════
  server.tool(
    "doc_compliance_check",
    "Check document compliance for a specific client: compares required documents (based on entity type and state) against actually processed documents in Supabase. Returns a checklist with ✅ present / ❌ missing for each required document, plus a compliance score (0-100%). Accepts account_id or company_name. For a cross-account compliance overview, use doc_compliance_report instead.",
    {
      account_id: z.string().uuid().optional().describe("Account UUID (use this if you have it)"),
      company_name: z.string().optional().describe("Company name search (use this if you don't have the ID)"),
    },
    async ({ account_id, company_name }) => {
      try {
        // 1. Find account
        let accountQuery = supabaseAdmin.from("accounts").select("id, company_name, entity_type, state_of_formation, drive_folder_id")
        if (account_id) {
          accountQuery = accountQuery.eq("id", account_id)
        } else if (company_name) {
          accountQuery = accountQuery.ilike("company_name", `%${company_name}%`)
        } else {
          return { content: [{ type: "text" as const, text: "❌ Provide either account_id or company_name" }] }
        }

        const { data: accounts, error: accErr } = await accountQuery
        if (accErr || !accounts?.length) {
          return { content: [{ type: "text" as const, text: accErr ? `❌ Error: ${accErr.message}` : "❌ Account not found" }] }
        }

        const account = accounts[0]

        if (!account.entity_type) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ ${account.company_name}: entity_type is not set.\nCannot check compliance without knowing the entity type.\nPlease update the account's entity_type first (Single Member LLC, Multi Member LLC, or C-Corp Elected).`,
            }],
          }
        }

        // 2. Get compliance requirements for this entity type
        const { data: requirements } = await supabaseAdmin
          .from("compliance_requirements")
          .select("*")
          .eq("entity_type", account.entity_type)
          .eq("is_required", true)
          .order("category", { ascending: true })

        if (!requirements || requirements.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ No compliance requirements defined for entity type "${account.entity_type}".\nThis may need to be configured in the compliance_requirements table.`,
            }],
          }
        }

        // 3. Get documents for this account
        const { data: docs } = await supabaseAdmin
          .from("documents")
          .select("document_type_name, status, confidence, file_name, processed_at")
          .eq("account_id", account.id)
          .eq("status", "classified")

        // Build a set of present document types
        const presentTypes = new Map<string, { fileName: string; confidence: string; processedAt: string }>()
        if (docs) {
          for (const d of docs) {
            if (d.document_type_name && !presentTypes.has(d.document_type_name)) {
              presentTypes.set(d.document_type_name, {
                fileName: d.file_name,
                confidence: d.confidence || "—",
                processedAt: d.processed_at ? new Date(d.processed_at).toLocaleDateString("it-IT") : "—",
              })
            }
          }
        }

        // 4. Compare: required vs present
        let found = 0
        let missing = 0
        const checklistLines: string[] = []

        const categoryNames: Record<number, string> = { 1: "Company", 2: "Contacts", 3: "Tax", 4: "Banking", 5: "Correspondence" }
        let lastCategory = 0

        for (const req of requirements) {
          if (req.category !== lastCategory) {
            checklistLines.push("")
            checklistLines.push(`── ${categoryNames[req.category] || `Category ${req.category}`} ──`)
            lastCategory = req.category
          }

          const present = presentTypes.get(req.document_type_name)
          if (present) {
            found++
            checklistLines.push(`✅ ${req.document_type_name} — ${present.fileName} [${present.confidence}]`)
          } else {
            missing++
            checklistLines.push(`❌ ${req.document_type_name} — MISSING`)
          }
        }

        const score = requirements.length > 0 ? Math.round((found / requirements.length) * 100) : 0
        const scoreEmoji = score === 100 ? "🟢" : score >= 60 ? "🟡" : "🔴"

        const lines = [
          `📋 Compliance Check: ${account.company_name}`,
          `🏢 Entity: ${account.entity_type} | 📍 ${account.state_of_formation || "—"}`,
          `📂 Drive folder: ${account.drive_folder_id ? "linked" : "NOT linked"}`,
          "",
          `${scoreEmoji} Score: ${score}% (${found}/${requirements.length} required documents present)`,
          ...checklistLines,
        ]

        if (missing > 0 && !account.drive_folder_id) {
          lines.push("", "💡 Tip: Account has no Drive folder linked. Run doc_bulk_process after linking to populate documents.")
        } else if (missing > 0) {
          lines.push("", `💡 Tip: ${missing} documents missing. They may not have been processed yet — try doc_bulk_process with this account.`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Compliance check failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_bulk_process — Process all documents for a CRM account (auto-resolves Drive folder)
  // ═══════════════════════════════════════
  server.tool(
    "doc_bulk_process",
    "Process all documents for a CRM client by account UUID — automatically resolves the client's Drive folder from accounts.drive_folder_id. Extracts text, classifies, and stores with automatic account linking. Max 20 files per call. Use offset to resume from where a previous call left off. PREFERRED over doc_process_client when you have the account_id (no need to look up the folder ID manually).",
    {
      account_id: z.string().uuid().describe("CRM account UUID — folder is auto-resolved from accounts.drive_folder_id"),
      skip_existing: z.boolean().optional().default(true).describe("Skip already-processed files (default: true). Set false to re-classify with updated rules."),
      offset: z.number().optional().default(0).describe("Skip this many files before processing (use to resume after timeout). E.g. offset=11 skips the first 11 files."),
    },
    async ({ account_id, skip_existing, offset }) => {
      try {
        const startTime = Date.now()

        // 1. Resolve account → drive_folder_id
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, drive_folder_id")
          .eq("id", account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `❌ Account not found: ${accErr?.message || account_id}` }] }
        }

        if (!account.drive_folder_id) {
          return {
            content: [{
              type: "text" as const,
              text: `❌ ${account.company_name} has no Drive folder linked (drive_folder_id is null).\n\n💡 Options:\n1. Set gdrive_folder_url on the account\n2. Use doc_process_client with a folder_id directly`,
            }],
          }
        }

        // 2. Recursively collect files
        const allFiles = await collectFilesRecursive(account.drive_folder_id, 3)

        if (allFiles.length === 0) {
          return { content: [{ type: "text" as const, text: `📭 No processable files found in ${account.company_name}'s Drive folder.` }] }
        }

        // 3. Check existing if skip_existing
        let toProcess = allFiles
        if (skip_existing) {
          const fileIds = allFiles.map(f => f.id)
          const existingIds = new Set<string>()
          for (let i = 0; i < fileIds.length; i += 50) {
            const chunk = fileIds.slice(i, i + 50)
            const { data: existing } = await supabaseAdmin
              .from("documents")
              .select("drive_file_id")
              .in("drive_file_id", chunk)
            existing?.forEach(e => existingIds.add(e.drive_file_id))
          }
          toProcess = allFiles.filter(f => !existingIds.has(f.id))
        }

        // 3b. Apply offset for resumable processing
        const fileOffset = offset || 0
        if (fileOffset > 0) {
          toProcess = toProcess.slice(fileOffset)
        }

        if (toProcess.length === 0) {
          return { content: [{ type: "text" as const, text: `✅ All ${allFiles.length} files in ${account.company_name} already processed. Nothing to do.` }] }
        }

        // 4. Process files (with timeout + batch limit)
        const batch = toProcess.slice(0, BATCH_MAX_FILES)
        const results: Array<{ fileName: string; status: string; type?: string; error?: string }> = []
        let timedOut = false

        for (const file of batch) {
          if (Date.now() - startTime > BATCH_TIMEOUT_MS) {
            timedOut = true
            break
          }
          const r = await processFile(file.id, account.id, account.company_name)
          results.push({ fileName: r.fileName, status: r.status, type: r.type, error: r.error })
        }

        // 5. Summary
        const classified = results.filter(r => r.status === "classified").length
        const unclassified = results.filter(r => r.status === "unclassified").length
        const errors = results.filter(r => r.status === "error").length
        const skipped = allFiles.length - toProcess.length
        const remaining = toProcess.length - results.length

        const nextOffset = fileOffset + results.length
        const lines = [
          `📊 Bulk Process: ${account.company_name}`,
          "",
          `📄 Total files: ${allFiles.length} | Skipped (existing): ${skipped} | Offset: ${fileOffset} | Processed: ${results.length}`,
          `✅ Classified: ${classified} | ⚠️ Unclassified: ${unclassified} | ❌ Errors: ${errors}`,
          timedOut ? `⏱️ Timeout — ${remaining} files remaining → run again with offset: ${nextOffset}` : "",
          remaining > 0 && !timedOut ? `📌 Batch limit — ${remaining} files remaining → run again with offset: ${nextOffset}` : "",
          "",
          "── Details ──",
        ]

        for (const r of results) {
          const icon = r.status === "classified" ? "✅" : r.status === "unclassified" ? "⚠️" : "❌"
          lines.push(`${icon} ${r.fileName} → ${r.type || r.status}${r.error ? ` (${r.error.slice(0, 80)})` : ""}`)
        }

        if (results.length > 0) {
          logAction({
            action_type: "process",
            table_name: "documents",
            account_id: account_id,
            summary: `Bulk processed ${account.company_name}: ${classified} classified, ${unclassified} unclassified, ${errors} errors`,
            details: { account_name: account.company_name, total: results.length, classified, unclassified, errors, skipped },
          })
        }

        return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Bulk process failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_compliance_report — Aggregate compliance across all accounts
  // ═══════════════════════════════════════
  server.tool(
    "doc_compliance_report",
    "Generate an aggregate compliance report across all active CRM accounts. Shows each account's compliance score and health (green ≥80% / yellow ≥50% / red <50%), most commonly missing documents, and breakdown by entity type. Read-only — does not process files or update records. Filter by entity_type, state, or score range. For a single client's compliance, use doc_compliance_check instead.",
    {
      entity_type: z.string().optional().describe("Filter by entity type (e.g. 'Single Member LLC')"),
      state: z.string().optional().describe("Filter by state_of_formation"),
      min_score: z.number().optional().describe("Show only accounts with score >= this (0-100)"),
      max_score: z.number().optional().describe("Show only accounts with score <= this (0-100)"),
    },
    async ({ entity_type, state, min_score, max_score }) => {
      try {
        // 1. Parallel queries
        let accountsQuery = supabaseAdmin
          .from("accounts")
          .select("id, company_name, entity_type, state_of_formation, status, client_health")
          .eq("status", "Active")
        if (entity_type) accountsQuery = accountsQuery.eq("entity_type", entity_type)
        if (state) accountsQuery = accountsQuery.eq("state_of_formation", state)

        const [accountsRes, requirementsRes, docsRes] = await Promise.all([
          accountsQuery.order("company_name"),
          supabaseAdmin.from("compliance_requirements").select("*").eq("is_required", true),
          supabaseAdmin
            .from("documents")
            .select("account_id, document_type_name, status")
            .eq("status", "classified")
            .not("account_id", "is", null),
        ])

        const accounts = accountsRes.data || []
        const requirements = requirementsRes.data || []
        const docs = docsRes.data || []

        // 2. Build requirements map: entity_type → Set<document_type_name>
        const reqMap: Record<string, string[]> = {}
        for (const r of requirements) {
          if (!reqMap[r.entity_type]) reqMap[r.entity_type] = []
          reqMap[r.entity_type].push(r.document_type_name)
        }

        // 3. Build docs map: account_id → Set<document_type_name>
        const docMap: Record<string, Set<string>> = {}
        for (const d of docs) {
          if (!d.account_id) continue
          if (!docMap[d.account_id]) docMap[d.account_id] = new Set()
          docMap[d.account_id].add(d.document_type_name)
        }

        // 4. Calculate scores
        interface AccountScore {
          id: string
          name: string
          entityType: string | null
          state: string | null
          score: number
          found: number
          required: number
          missing: string[]
          color: string
        }

        const scores: AccountScore[] = []
        const missingCounts: Record<string, number> = {}
        let noEntityCount = 0
        let noDocsCount = 0

        for (const acc of accounts) {
          if (!acc.entity_type) {
            noEntityCount++
            continue
          }

          const required = reqMap[acc.entity_type] || []
          if (required.length === 0) continue

          const present = docMap[acc.id] || new Set<string>()
          const found = required.filter(r => present.has(r)).length
          const score = Math.round((found / required.length) * 100)
          const missing = required.filter(r => !present.has(r))

          if (present.size === 0) noDocsCount++

          // Count missing documents globally
          for (const m of missing) {
            missingCounts[m] = (missingCounts[m] || 0) + 1
          }

          const color = score >= 80 ? "green" : score >= 50 ? "yellow" : "red"

          // Apply score filters
          if (min_score !== undefined && score < min_score) continue
          if (max_score !== undefined && score > max_score) continue

          scores.push({
            id: acc.id,
            name: acc.company_name,
            entityType: acc.entity_type,
            state: acc.state_of_formation,
            score,
            found,
            required: required.length,
            missing,
            color,
          })
        }

        // 5. Aggregate
        const green = scores.filter(s => s.color === "green")
        const yellow = scores.filter(s => s.color === "yellow")
        const red = scores.filter(s => s.color === "red")
        const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, a) => s + a.score, 0) / scores.length) : 0

        // By entity type
        const byEntity: Record<string, { g: number; y: number; r: number; total: number; sum: number }> = {}
        for (const s of scores) {
          const et = s.entityType || "Unknown"
          if (!byEntity[et]) byEntity[et] = { g: 0, y: 0, r: 0, total: 0, sum: 0 }
          byEntity[et][s.color === "green" ? "g" : s.color === "yellow" ? "y" : "r"]++
          byEntity[et].total++
          byEntity[et].sum += s.score
        }

        // Top missing docs
        const topMissing = Object.entries(missingCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)

        // 6. Build output
        const lines = [
          `📋 Compliance Report — ${scores.length} accounts analyzed`,
          "",
          "── Summary ──",
          `🟢 Green (≥80%): ${green.length} accounts (${scores.length ? Math.round(green.length / scores.length * 100) : 0}%)`,
          `🟡 Yellow (50-79%): ${yellow.length} accounts (${scores.length ? Math.round(yellow.length / scores.length * 100) : 0}%)`,
          `🔴 Red (<50%): ${red.length} accounts (${scores.length ? Math.round(red.length / scores.length * 100) : 0}%)`,
          `⚪ No entity type: ${noEntityCount} accounts (not checked)`,
          `📄 No documents yet: ${noDocsCount} accounts`,
          `📊 Average score: ${avgScore}%`,
          "",
          "── Most Common Missing Documents ──",
        ]

        for (const [doc, count] of topMissing) {
          const pct = scores.length > 0 ? Math.round(count / scores.length * 100) : 0
          lines.push(`  ${doc} — missing in ${count} accounts (${pct}%)`)
        }

        lines.push("", "── By Entity Type ──")
        for (const [et, stats] of Object.entries(byEntity)) {
          const avg = stats.total > 0 ? Math.round(stats.sum / stats.total) : 0
          lines.push(`  ${et}: 🟢${stats.g} 🟡${stats.y} 🔴${stats.r} (avg ${avg}%)`)
        }

        // Red accounts (top 20)
        if (red.length > 0) {
          lines.push("", "── 🔴 Red Accounts (top 20) ──")
          const topRed = red.sort((a, b) => a.score - b.score).slice(0, 20)
          for (const a of topRed) {
            lines.push(`  🔴 ${a.score}% — ${a.name} (${a.entityType}, ${a.state || "?"}) — missing: ${a.missing.join(", ")}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Compliance report failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_mass_process — Process all accounts with Drive folders (cursor-based)
  // ═══════════════════════════════════════
  server.tool(
    "doc_mass_process",
    "Mass-process documents across ALL active CRM accounts that have linked Drive folders (accounts.drive_folder_id). Processes accounts one by one in alphabetical order, extracting, classifying, and storing documents. Cursor-based: use after_account_id to resume from a previous run's next_cursor. Default: 5 accounts per call. Returns per-account results and next cursor for continuation.",
    {
      after_account_id: z.string().uuid().optional().describe("Resume cursor — start after this account ID (from previous run's next_cursor)"),
      skip_existing: z.boolean().optional().default(true).describe("Skip already-processed files (default true)"),
      limit: z.number().optional().default(5).describe("Max accounts to attempt per call (default 5)"),
    },
    async ({ after_account_id, skip_existing, limit: maxAccounts }) => {
      try {
        const startTime = Date.now()

        // 1. Get accounts to process
        let query = supabaseAdmin
          .from("accounts")
          .select("id, company_name, drive_folder_id")
          .eq("status", "Active")
          .not("drive_folder_id", "is", null)
          .order("company_name", { ascending: true })
          .limit(maxAccounts || 5)

        if (after_account_id) {
          // Get the company_name of the cursor account for keyset pagination
          const { data: cursorAcc } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", after_account_id)
            .single()
          if (cursorAcc) {
            query = query.gt("company_name", cursorAcc.company_name)
          }
        }

        const { data: accounts, error: accErr } = await query

        if (accErr || !accounts || accounts.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: after_account_id
                ? `✅ Mass processing complete — no more accounts after cursor.`
                : `📭 No active accounts with Drive folders found.`,
            }],
          }
        }

        // 2. Process each account
        interface AccResult {
          id: string
          name: string
          totalFiles: number
          processed: number
          classified: number
          unclassified: number
          errors: number
          skipped: number
          partial: boolean
        }

        const accResults: AccResult[] = []
        let lastProcessedId = ""
        let timedOut = false

        for (const acc of accounts) {
          if (Date.now() - startTime > BATCH_TIMEOUT_MS) {
            timedOut = true
            break
          }

          const result: AccResult = {
            id: acc.id,
            name: acc.company_name,
            totalFiles: 0,
            processed: 0,
            classified: 0,
            unclassified: 0,
            errors: 0,
            skipped: 0,
            partial: false,
          }

          try {
            // Collect files
            const allFiles = await collectFilesRecursive(acc.drive_folder_id!, 3)
            result.totalFiles = allFiles.length

            if (allFiles.length === 0) {
              lastProcessedId = acc.id
              accResults.push(result)
              continue
            }

            // Filter existing
            let toProcess = allFiles
            if (skip_existing) {
              const fileIds = allFiles.map(f => f.id)
              const existingIds = new Set<string>()
              for (let i = 0; i < fileIds.length; i += 50) {
                const chunk = fileIds.slice(i, i + 50)
                const { data: existing } = await supabaseAdmin
                  .from("documents")
                  .select("drive_file_id")
                  .in("drive_file_id", chunk)
                existing?.forEach(e => existingIds.add(e.drive_file_id))
              }
              result.skipped = existingIds.size
              toProcess = allFiles.filter(f => !existingIds.has(f.id))
            }

            if (toProcess.length === 0) {
              lastProcessedId = acc.id
              accResults.push(result)
              continue
            }

            // Process batch
            for (const file of toProcess.slice(0, BATCH_MAX_FILES)) {
              if (Date.now() - startTime > BATCH_TIMEOUT_MS) {
                result.partial = true
                timedOut = true
                break
              }
              const r = await processFile(file.id, acc.id, acc.company_name)
              result.processed++
              if (r.status === "classified") result.classified++
              else if (r.status === "unclassified") result.unclassified++
              else result.errors++
            }

            if (toProcess.length > BATCH_MAX_FILES) result.partial = true

          } catch (e) {
            result.errors++
          }

          lastProcessedId = acc.id
          accResults.push(result)

          if (timedOut) break
        }

        // 3. Summary
        const totalProcessed = accResults.reduce((s, a) => s + a.processed, 0)
        const totalClassified = accResults.reduce((s, a) => s + a.classified, 0)
        const totalUnclassified = accResults.reduce((s, a) => s + a.unclassified, 0)
        const totalErrors = accResults.reduce((s, a) => s + a.errors, 0)
        const completed = accResults.filter(a => !a.partial && a.processed > 0 || a.skipped === a.totalFiles).length
        const partial = accResults.filter(a => a.partial).length

        const lines = [
          `📊 Mass Process — ${accResults.length} accounts attempted`,
          "",
          `🏢 Completed: ${completed} | Partial: ${partial}`,
          `📄 Files processed: ${totalProcessed} | ✅ ${totalClassified} | ⚠️ ${totalUnclassified} | ❌ ${totalErrors}`,
          "",
          "── Per Account ──",
        ]

        for (const a of accResults) {
          if (a.totalFiles === 0) {
            lines.push(`📭 ${a.name} — empty folder`)
          } else if (a.skipped === a.totalFiles) {
            lines.push(`⏭️ ${a.name} — all ${a.totalFiles} files already done`)
          } else if (a.partial) {
            lines.push(`🟡 ${a.name} — ${a.processed}/${a.totalFiles - a.skipped} new files (partial)`)
          } else {
            lines.push(`✅ ${a.name} — ${a.processed} files (✅${a.classified} ⚠️${a.unclassified} ❌${a.errors})`)
          }
        }

        if (timedOut || accResults.length === (maxAccounts || 5)) {
          lines.push("", `📌 Next cursor: ${lastProcessedId}`)
          lines.push(`💡 Run again with after_account_id: "${lastProcessedId}" to continue`)
        } else {
          lines.push("", "✅ All accounts processed!")
        }

        if (totalProcessed > 0) {
          logAction({
            action_type: "process",
            table_name: "documents",
            summary: `Mass processed ${accResults.length} accounts: ${totalClassified} classified, ${totalUnclassified} unclassified, ${totalErrors} errors`,
            details: { accounts: accResults.length, totalProcessed, totalClassified, totalUnclassified, totalErrors },
          })
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Mass process failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // doc_update_health — Batch update client_health from compliance scores
  // ═══════════════════════════════════════
  server.tool(
    "doc_update_health",
    "Batch-update accounts.client_health field (green/yellow/red) based on document compliance scores. Green ≥80% (configurable), yellow ≥50%, red <50%. Use dry_run=true first to preview which accounts would change. Run this after doc_mass_process or doc_compliance_report to sync health indicators with actual compliance data.",
    {
      dry_run: z.boolean().optional().default(true).describe("Preview changes without updating (default true)"),
      green_threshold: z.number().optional().default(80).describe("Score >= this = green (default 80)"),
      yellow_threshold: z.number().optional().default(50).describe("Score >= this = yellow (default 50)"),
    },
    async ({ dry_run, green_threshold, yellow_threshold }) => {
      try {
        const greenT = green_threshold ?? 80
        const yellowT = yellow_threshold ?? 50

        // 1. Get accounts with entity_type
        const [accountsRes, requirementsRes, docsRes] = await Promise.all([
          supabaseAdmin
            .from("accounts")
            .select("id, company_name, entity_type, client_health, status")
            .eq("status", "Active")
            .not("entity_type", "is", null),
          supabaseAdmin.from("compliance_requirements").select("*").eq("is_required", true),
          supabaseAdmin
            .from("documents")
            .select("account_id, document_type_name, status")
            .eq("status", "classified")
            .not("account_id", "is", null),
        ])

        const accounts = accountsRes.data || []
        const requirements = requirementsRes.data || []
        const docs = docsRes.data || []

        // Build maps
        const reqMap: Record<string, string[]> = {}
        for (const r of requirements) {
          if (!reqMap[r.entity_type]) reqMap[r.entity_type] = []
          reqMap[r.entity_type].push(r.document_type_name)
        }

        const docMap: Record<string, Set<string>> = {}
        for (const d of docs) {
          if (!d.account_id) continue
          if (!docMap[d.account_id]) docMap[d.account_id] = new Set()
          docMap[d.account_id].add(d.document_type_name)
        }

        // 2. Calculate changes
        interface HealthChange {
          id: string
          name: string
          oldHealth: string | null
          newHealth: string
          score: number
        }

        const changes: HealthChange[] = []
        let unchanged = 0

        for (const acc of accounts) {
          const required = reqMap[acc.entity_type!] || []
          if (required.length === 0) continue

          const present = docMap[acc.id] || new Set<string>()
          const found = required.filter(r => present.has(r)).length
          const score = Math.round((found / required.length) * 100)

          const newHealth = score >= greenT ? "green" : score >= yellowT ? "yellow" : "red"

          if (acc.client_health === newHealth) {
            unchanged++
            continue
          }

          changes.push({
            id: acc.id,
            name: acc.company_name,
            oldHealth: acc.client_health,
            newHealth,
            score,
          })
        }

        // 3. Apply or preview
        if (!dry_run && changes.length > 0) {
          // Batch update in chunks of 10
          for (let i = 0; i < changes.length; i += 10) {
            const chunk = changes.slice(i, i + 10)
            for (const c of chunk) {
              await supabaseAdmin
                .from("accounts")
                .update({ client_health: c.newHealth, updated_at: new Date().toISOString() })
                .eq("id", c.id)
            }
          }
        }

        // 4. Summary
        const toGreen = changes.filter(c => c.newHealth === "green").length
        const toYellow = changes.filter(c => c.newHealth === "yellow").length
        const toRed = changes.filter(c => c.newHealth === "red").length

        const lines = [
          dry_run ? "🔍 Health Update Preview (DRY RUN)" : "✅ Health Updated",
          "",
          `📊 Accounts analyzed: ${accounts.length}`,
          `🔄 Changes: ${changes.length} | Unchanged: ${unchanged}`,
          `   → 🟢 green: ${toGreen} | 🟡 yellow: ${toYellow} | 🔴 red: ${toRed}`,
          `   Thresholds: green ≥${greenT}%, yellow ≥${yellowT}%`,
        ]

        if (changes.length > 0) {
          lines.push("", "── Changes ──")
          for (const c of changes.slice(0, 30)) {
            const arrow = `${c.oldHealth || "null"} → ${c.newHealth}`
            lines.push(`  ${c.newHealth === "green" ? "🟢" : c.newHealth === "yellow" ? "🟡" : "🔴"} ${c.name} — ${c.score}% (${arrow})`)
          }
          if (changes.length > 30) {
            lines.push(`  ... and ${changes.length - 30} more`)
          }
        }

        if (dry_run && changes.length > 0) {
          lines.push("", "💡 Run with dry_run=false to apply these changes")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Health update failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

}
