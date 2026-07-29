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
}
