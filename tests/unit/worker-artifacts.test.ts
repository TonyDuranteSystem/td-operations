/**
 * Files the worker produces must reach the staff member as DATA, not as prose.
 *
 * On the first live run of pdf_create the worker built the document correctly and then
 * replied "Here's the PDF — ready to print and post." with the download link dropped
 * entirely. That is Luca's 10 July complaint reproduced exactly, by the feature built
 * to fix it: a file that exists but cannot be reached.
 *
 * So the link is lifted from OUR OWN tool output server-side and rendered by the panel.
 * These tests pin that extraction — including that it refuses to pick up a URL that
 * merely appeared in some other tool's result, e.g. one quoted in a client's email.
 */

import { describe, it, expect } from 'vitest'
import { extractArtifact } from '@/lib/ai-agent/worker-tools'
import { claimsFileProduced, buildPhantomFileNudge } from '@/lib/ai-agent/answer-guards'

const RESULT = [
  '📄 PDF ready — 18 KB',
  'Download: https://example.supabase.co/storage/v1/object/sign/worker-attachments/worker-chat/abc.pdf?token=xyz',
  '',
  'The link works for 24 hours.',
].join('\n')

describe('extractArtifact', () => {
  it('lifts the download link out of a pdf_create result', () => {
    const a = extractArtifact('pdf_create', RESULT)
    expect(a).not.toBeNull()
    expect(a!.kind).toBe('pdf')
    expect(a!.url).toMatch(/^https:\/\//)
    expect(a!.label).toBe('Download PDF')
  })

  it('works when the tool was reached through the catalog bridge', () => {
    expect(extractArtifact('use_tool', RESULT)).not.toBeNull()
  })

  it('ignores tools that do not produce files — a URL in an email is not a download', () => {
    // The dangerous version of this feature is a loose "find any link" over every tool
    // result: a client's email quoting a URL would become a download button.
    expect(extractArtifact('gmail_read', RESULT)).toBeNull()
    expect(extractArtifact('doc_search', RESULT)).toBeNull()
  })

  it('returns nothing when the tool failed', () => {
    expect(extractArtifact('pdf_create', '❌ Could not produce the PDF: disk full.')).toBeNull()
  })

  it('does not pick up a link that is merely mentioned in passing', () => {
    // Only the exact line our tool emits counts.
    expect(extractArtifact('pdf_create', 'See https://example.com/thing for details')).toBeNull()
  })

  it('is safe on non-string results', () => {
    expect(extractArtifact('pdf_create', null)).toBeNull()
    expect(extractArtifact('pdf_create', { url: 'https://x' })).toBeNull()
  })
})

describe('claiming a file that was never made', () => {
  it('catches the exact phrasings observed in sandbox', () => {
    for (const reply of [
      "**IRS_Name_Change.pdf** is attached above and ready to print.",
      "Here you go — Test_Letter.pdf is attached above.",
      "Here's the PDF — ready to print and post.",
      "I've generated the document for you.",
      "The PDF is ready.",
    ]) {
      expect(claimsFileProduced(reply), reply).toBe(true)
    }
  })

  it('does not fire on ordinary talk about documents', () => {
    // Discussing a PDF, or offering to make one, is not claiming to have made one.
    for (const ok of [
      'I can produce that as a PDF if you want — say the word.',
      'The client uploaded a PDF last week; I read it.',
      'That letter should be printed and posted to the IRS.',
      'Their W-7 is filed in Drive under Tax.',
      '',
    ]) {
      expect(claimsFileProduced(ok), ok).toBe(false)
    }
  })
})

describe('buildPhantomFileNudge', () => {
  const nudge = buildPhantomFileNudge()

  it('states plainly that it cannot create files itself', () => {
    expect(nudge).toMatch(/CANNOT create files yourself/i)
    expect(nudge).toMatch(/no code execution/i)
  })

  it('names the one tool that actually works', () => {
    expect(nudge).toMatch(/pdf_create/)
  })

  it('gives an honest fallback rather than only a scolding', () => {
    expect(nudge).toMatch(/give them the text/i)
  })
})
