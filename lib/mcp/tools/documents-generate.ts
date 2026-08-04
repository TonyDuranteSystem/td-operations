/**
 * Document generation — turn text into a PDF the staff member can download.
 *
 * Antonio, 2026-07-19: "as I say to a code session: find a PDF or produce a PDF or give
 * me this text. The AI agent and the worker must do the same thing."
 *
 * Origin (Luca, 2026-07-10): he asked the worker for the IRS name-change letter as a
 * PDF, got plain text plus an offer to download a file that was never created, and had
 * to reformat it by hand. Every other PDF here fills a known template; nothing could
 * take arbitrary text and produce a printable page.
 *
 * WHY THIS IS A CATALOG TOOL, not a panel feature: it is registered with the MCP server,
 * so the CRM panels, the Claude.ai connector and a code session all reach the same one.
 * "The AI agent and the worker must do the same thing" is easier to keep true when there
 * is only one thing.
 *
 * WHERE THE FILE GOES: the private worker-attachments bucket, never a public URL, and
 * the caller gets a time-limited signed link. Documents made here routinely contain a
 * client's EIN or address, so a permanent public link would be a quiet leak. Filing the
 * result into Drive or onto a client record is deliberately NOT part of this tool —
 * that is client-visible and belongs behind an approval.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { renderLetterPdf } from '@/lib/pdf/letter-pdf'
import { WORKER_UPLOAD_BUCKET } from '@/lib/ai-agent/attachment-reader'

/**
 * How long the download link lives.
 *
 * Long enough to finish the job it was made for, short enough that a link pasted into a
 * chat months ago stops working. These files carry client identifiers.
 */
const LINK_TTL_SECONDS = 60 * 60 * 24 // 24 hours

/** Keep the filename recognisable in a downloads folder without inviting a path. */
function safeFileStem(title: string | undefined, fallback: string): string {
  const base = (title ?? '').trim() || fallback
  return (
    base
      // Keep letters, digits, spaces, underscore and hyphen. Anything else — slashes,
      // dots, quotes — is dropped so a title can never shape a path or an extension.
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '') || fallback
  )
}

export function registerDocumentGenerationTools(server: McpServer) {
  server.tool(
    "pdf_create",
    "Turn text into a downloadable PDF and return a link to it. Use this whenever someone asks for a letter, notice, summary or any text 'as a PDF' — an IRS notification letter, a client summary, a cover note. Write the full text yourself in `body`, then call this once. Returns a time-limited download link the staff member can click. The file is NOT filed to Drive or attached to a client record — say so, and offer to do that separately if they want it.",
    {
      body: z
        .string()
        .min(1)
        .describe(
          'The complete document text. Blank lines separate paragraphs. A line of "## Heading" or "**Heading**" alone becomes a bold heading; a line starting "- " becomes a bullet. Write the finished text — do not summarise or abbreviate.',
        ),
      title: z
        .string()
        .optional()
        .describe('Bold line at the top, e.g. "Notification of Company Name Change". Also names the file.'),
      date_line: z
        .string()
        .optional()
        .describe('Date shown under the letterhead, e.g. "19 July 2026". Omit if the document should carry no date.'),
      reference: z
        .array(z.string())
        .optional()
        .describe('Short reference lines under the title, e.g. ["Re: DF Commerce LLC", "EIN: 12-3456789"].'),
      // `.nullable()` as well as `.optional()`: an assistant asked for "no letterhead"
      // will reach for null at least as readily as for "", and a bare `.string()
      // .optional()` REJECTS null — so the honest attempt failed validation and the
      // header survived. Both spellings now mean bare; omitting the key means default.
      letterhead: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Sender line at the very top. Defaults to "Tony Durante LLC". Pass "" or null for a bare document with no header.',
        ),
    },
    async ({ body, title, date_line, reference, letterhead }) => {
      try {
        const bytes = await renderLetterPdf({
          body,
          title: title ?? null,
          dateLine: date_line ?? null,
          reference: reference ?? null,
          // Passed through UNCHANGED on purpose. `?? null` here would turn "caller
          // said nothing" into "caller asked for no letterhead" and strip the firm's
          // header off every document — the renderer distinguishes absent (default)
          // from an explicit ''/null (bare).
          letterhead,
        })

        // Same path shape the panel uploads use, so the bucket's existing rules and
        // path validation apply unchanged.
        const path = `worker-chat/${randomUUID()}.pdf`
        const { error: upErr } = await supabaseAdmin.storage
          .from(WORKER_UPLOAD_BUCKET)
          .upload(path, Buffer.from(bytes), { contentType: 'application/pdf', upsert: false })
        if (upErr) throw new Error(upErr.message)

        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from(WORKER_UPLOAD_BUCKET)
          .createSignedUrl(path, LINK_TTL_SECONDS, {
            download: `${safeFileStem(title, 'document')}.pdf`,
          })
        if (signErr || !signed?.signedUrl) throw new Error(signErr?.message ?? 'could not create the download link')

        const kb = Math.max(1, Math.round(bytes.length / 1024))
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `📄 PDF ready — ${kb} KB`,
                `Download: ${signed.signedUrl}`,
                '',
                'The link works for 24 hours. The file has NOT been filed to Drive or attached to the client record — offer to do that separately if it is wanted.',
              ].join('\n'),
            },
          ],
        }
      } catch (err) {
        // Say what failed. A vague error here sends the staff member back to
        // reformatting by hand without knowing why.
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: `❌ Could not produce the PDF: ${msg}. Do not claim a file was created — offer the text instead so it is not lost.`,
            },
          ],
        }
      }
    },
  )

  /**
   * spreadsheet_create — the other half of "find a file, produce a file, or give me
   * the text", for tabular work.
   *
   * Origin (Luca, td-bug 2026-07-29 → 2026-08-03): "I wanted to upload an Excel file
   * to the AI Agent so it could update it with additional information", and later
   * "is it possible for the AI Agent to modify Excel files directly … it could
   * potentially allow us to replace Claude Browser for everything". Reading was
   * fixed first; this is the write half.
   *
   * SCOPE, and it must be said to the staff member rather than assumed: this builds
   * a NEW workbook from the rows the assistant supplies. It is not an in-place edit
   * of the file they uploaded — their formatting, formulas, column widths and
   * hidden sheets are NOT carried over. For "update my tracker" the honest flow is:
   * read their file, produce a corrected copy, and let them look at both.
   *
   * Same bucket, same private path shape and same signed-link TTL as pdf_create —
   * these sheets carry client identifiers just as readily as the letters do.
   */
  server.tool(
    "spreadsheet_create",
    "Build a downloadable Excel file (.xlsx) from rows you supply, and return a link to it. Use this whenever someone asks for a table, list, tracker, reconciliation or comparison 'as a spreadsheet' or 'as Excel' — including handing back a corrected version of a spreadsheet they uploaded. Give every sheet its rows as arrays of cell values (first row = headers). Returns a time-limited download link. IMPORTANT: this creates a NEW workbook from the values you provide — it does NOT edit their original file in place, and their formatting, formulas and column widths are not preserved. Say that plainly when you hand it over. The file is NOT filed to Drive or attached to a client record.",
    {
      sheets: z
        .array(
          z.object({
            name: z
              .string()
              .min(1)
              .describe('Tab name, e.g. "All Companies". Keep it under 31 characters — Excel\'s own limit.'),
            rows: z
              .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
              .min(1)
              .describe(
                "The sheet's rows, in order, each an array of cell values. The FIRST row should be the column headers. Write real values — never placeholders like '...' or 'etc'.",
              ),
          }),
        )
        .min(1)
        .describe("One entry per tab. Use several tabs when the data has genuinely separate sections."),
      title: z
        .string()
        .optional()
        .describe('Names the downloaded file, e.g. "Tax Returns 2025 — corrected".'),
    },
    async ({ sheets, title }) => {
      try {
        const ExcelJS = (await import('exceljs')).default
        const wb = new ExcelJS.Workbook()
        for (const sheet of sheets) {
          // Excel refuses > 31 chars and the characters below; a rejected name
          // throws from deep inside the library with nothing naming the sheet.
          const safeName = (sheet.name || 'Sheet').replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet'
          const ws = wb.addWorksheet(safeName)
          sheet.rows.forEach((row) => ws.addRow(row.map((c) => (c === null ? '' : c))))
          // Bold the header row — it is the first thing a human looks for, and a
          // returned sheet that looks unformatted reads as unfinished work.
          if (ws.rowCount > 0) ws.getRow(1).font = { bold: true }
          // Width from content, bounded: unbounded auto-fit on a long note column
          // produces a sheet nobody can read without scrolling sideways.
          ws.columns.forEach((col) => {
            let widest = 10
            col.eachCell?.({ includeEmpty: false }, (cell) => {
              widest = Math.max(widest, String(cell.value ?? '').length + 2)
            })
            col.width = Math.min(widest, 60)
          })
        }

        const bytes = Buffer.from(await wb.xlsx.writeBuffer())
        const path = `worker-chat/${randomUUID()}.xlsx`
        const { error: upErr } = await supabaseAdmin.storage
          .from(WORKER_UPLOAD_BUCKET)
          .upload(path, bytes, {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            upsert: false,
          })
        if (upErr) throw new Error(upErr.message)

        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from(WORKER_UPLOAD_BUCKET)
          .createSignedUrl(path, LINK_TTL_SECONDS, {
            download: `${safeFileStem(title, 'spreadsheet')}.xlsx`,
          })
        if (signErr || !signed?.signedUrl) throw new Error(signErr?.message ?? 'could not create the download link')

        const kb = Math.max(1, Math.round(bytes.length / 1024))
        const rowTotal = sheets.reduce((n, sh) => n + sh.rows.length, 0)
        return {
          content: [
            {
              type: 'text' as const,
              // "Download: <url>" on its own line is the SHAPE the panel's artifact
              // extractor matches to render a download button. Do not reword it.
              text: [
                `\u{1F4C8} Spreadsheet ready — ${sheets.length} sheet(s), ${rowTotal} rows, ${kb} KB`,
                `Download: ${signed.signedUrl}`,
                '',
                'The link works for 24 hours. This is a NEW workbook built from the values above — it is not an edit of any file that was uploaded, so the original formatting, formulas and column widths are not carried over. Say that when handing it over. It has NOT been filed to Drive or attached to the client record.',
              ].join('\n'),
            },
          ],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: `\u{274C} Could not produce the spreadsheet: ${msg}. Do not claim a file was created — offer the rows as text instead so the work is not lost.`,
            },
          ],
        }
      }
    },
  )
}
