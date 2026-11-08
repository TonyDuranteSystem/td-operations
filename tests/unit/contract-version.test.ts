/**
 * N0b (dev job f907220c): the contract-text version recorded on offers and signatures.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  CURRENT_CONTRACT_VERSION, LEGACY_CONTRACT_VERSION, PRE_VERSIONING, contractVersionLabel,
  portalChatVoiceWording, usesVoiceNoteWording, versionSignedFor,
} from '@/lib/offers/contract-version'
import { toPublicRenewalView } from '@/lib/offers/public-offer-view'

describe('contract version', () => {
  it('is pinned — a new version is only added together with the wording it changes (and the database default moves with it)', () => {
    expect(LEGACY_CONTRACT_VERSION).toBe('2026-09-30')
    expect(CURRENT_CONTRACT_VERSION).toBe('2026-11-08')
  })

  it('the database default stamps the current version on every NEW offer; the first migration is history and still says 2026-09-30', () => {
    const sql = readFileSync('scripts/migrations/20261108-1730-contract-version-voice-notes.sql', 'utf8')
    expect(sql).toContain(`SET DEFAULT '${CURRENT_CONTRACT_VERSION}'`)
    // it moves the default only: no existing offer is touched
    expect(sql).not.toMatch(/^\s*UPDATE\s/im)
    const undo = readFileSync('scripts/migrations/20261108-1730-contract-version-voice-notes.UNDO.sql', 'utf8')
    expect(undo).toContain(`SET DEFAULT '${LEGACY_CONTRACT_VERSION}'`)
    const first = readFileSync('scripts/migrations/20260930-2330-n0b-contract-version.sql', 'utf8')
    expect(first).toContain(`SET DEFAULT '${LEGACY_CONTRACT_VERSION}'`)
    expect(first).toContain(`'${PRE_VERSIONING}'`)
  })

  it('"voice notes" wording only for an offer stamped 2026-11-08 or later — an offer that already exists never changes', () => {
    for (const v of [null, undefined, '', PRE_VERSIONING, '2026-09-30', '2026-11-07', 'garbage', '2026-9-30']) {
      expect(usesVoiceNoteWording(v as string | null | undefined), String(v)).toBe(false)
    }
    for (const v of ['2026-11-08', '2026-11-09', '2027-01-01']) expect(usesVoiceNoteWording(v), v).toBe(true)
  })

  it('the old wording is kept BYTE FOR BYTE for old offers; the new wording is for new ones', () => {
    for (const v of [null, PRE_VERSIONING, '2026-09-30']) {
      expect(portalChatVoiceWording(v)).toEqual({
        bulletTitle: 'Voice dictation',
        bulletBody: 'Press the microphone icon, dictate your message. The portal transcribes automatically.',
        clauseSupport: 'voice dictation support',
      })
    }
    expect(portalChatVoiceWording('2026-11-08')).toEqual({
      bulletTitle: 'Voice notes',
      bulletBody: 'Press the microphone icon, record your message and send it. Tap "Show text" to read it.',
      clauseSupport: 'voice note support',
    })
  })

  it('a client signing an offer records the version the offer carries (= the text shown); no usable stamp = the first version', () => {
    expect(versionSignedFor('2026-11-08')).toBe('2026-11-08')
    expect(versionSignedFor('2026-09-30')).toBe('2026-09-30')
    for (const v of [null, undefined, PRE_VERSIONING, 'garbage']) expect(versionSignedFor(v as string | null | undefined)).toBe(LEGACY_CONTRACT_VERSION)
  })

  it('both contract screens take the two Portal Chat lines from the versioned wording — no old text hard-coded any more', () => {
    for (const f of ['app/offer/[token]/contract/page.tsx', 'app/offer/[token]/contract/service-agreement.tsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain('portalChatVoiceWording(')
      expect(src, f).toContain('wording.bulletTitle'.replace('wording', f.includes('service-agreement') ? 'voiceWording' : 'wording'))
      expect(src, f).toContain('clauseSupport')
      expect(src, f).not.toContain('Voice dictation')
      expect(src, f).not.toContain('voice dictation support')
    }
  })

  it('labels a version for the client, and says nothing for offers signed before versions existed', () => {
    expect(contractVersionLabel('2026-09-30')).toBe('Contract version 2026-09-30')
    expect(contractVersionLabel(PRE_VERSIONING)).toBeNull()
    expect(contractVersionLabel(null)).toBeNull()
  })

  it('an unsigned renewal agreement is signed against today’s text; a signed one predates versions', () => {
    expect(toPublicRenewalView({ status: 'draft' }).contract_version).toBe(CURRENT_CONTRACT_VERSION)
    expect(toPublicRenewalView({ status: 'signed' }).contract_version).toBe(PRE_VERSIONING)
  })
})
