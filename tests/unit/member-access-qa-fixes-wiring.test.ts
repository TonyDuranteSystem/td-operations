/**
 * Wiring guards for the fixes that came out of the production QA of the portal-access tick (dev job beb43385, 21 Nov 2026).
 * They read the source so a later edit cannot quietly take one of the protections out.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const occurrences = (src: string, needle: string) => src.split(needle).length - 1

describe('the SS-4 signer keeps portal access (wizard + job)', () => {
  const wizard = read('app/portal/wizard/wizard-client.tsx')
  it('choosing a member as signer puts their tick back on', () => {
    expect(wizard).toContain('if (memberTickOn && index >= 0) next[')
    expect(wizard).toContain('_member_portal_access`] = true')
  })
  it('a saved draft with the signer unticked is stamped back on', () => {
    expect(wizard).toContain('const mustStayOn = requiresSs4Signer && signerIndex === i')
  })
  it('the signer\'s tick is drawn locked and ignores clicks', () => {
    expect(wizard).toContain('const lockedSigner = memberTickOn && requiresSs4Signer && signerIndex === idx')
    expect(wizard).toContain('if (lockedSigner) return;')
    expect(wizard).toContain('data-locked-signer-tick')
  })
  it('the onboarding job passes the signer flag too (member and company-representative paths)', () => {
    expect(occurrences(read('lib/jobs/handlers/onboarding-setup.ts'), 'isSs4Signer: isSs4SignerFlag')).toBe(2)
  })
  it('the formation job never marks the person chosen as signer (member and company-representative paths)', () => {
    const mat = read('lib/operations/formation-materialize.ts')
    expect(occurrences(mat, 'isSs4Signer: m.is_signer === true, ticked: m.member_portal_access')).toBe(2)
  })
})

describe('named-person senders ask the mark first', () => {
  it('bell, stage-change email, chat email and the action-required alert', () => {
    const n = read('lib/portal/notifications.ts')
    expect(occurrences(n, 'isMarkedOnCompany(')).toBeGreaterThanOrEqual(3)
    expect(read('lib/portal/action-required.ts')).toContain('isMarkedOnCompany(params.account_id, params.contact_id)')
  })
  it('the company push leaves out marked people', () => {
    expect(read('lib/portal/web-push.ts')).toContain('markedContactIds(accountId)')
  })
  it('the first-person pickers read only open links', () => {
    for (const f of ['lib/operations/file-renewal.ts', 'lib/installment-handler.ts', 'app/api/cron/portal-digest/route.ts']) {
      const src = read(f)
      const i = src.indexOf('account_contacts')
      expect(i, f).toBeGreaterThan(-1)
      expect(src.slice(i, i + 200), f).toMatch(/access_revoked_at/)
    }
  })
})

describe('staff Take away / Give', () => {
  const src = read('lib/members/staff-portal-access.ts')
  it('Take away does NOT delete the person\'s phone subscription (one row serves all their companies); the send filter handles it', () => {
    expect(src).not.toContain('push_subscriptions')
    expect(read('lib/portal/web-push.ts')).toContain('markedContactIds(accountId)')
  })
  it('Give keeps the team member\'s id on the link', () => {
    expect(src).toContain('by: p.staffUserId ?? null')
    expect(read('app/(dashboard)/accounts/actions.ts')).toContain('staffUserId: user.id })')
  })
})

describe('the other doors out of a company use the removal guard', () => {
  it('Unlink, old Revoke access and Delete contact', () => {
    expect(read('app/(dashboard)/accounts/actions.ts')).toContain('wouldLeaveOnlyMarkedPeople(accountId, contactId)')
    expect(read('app/api/crm/admin-actions/contact-portal/route.ts')).toContain('wouldLeaveOnlyMarkedPeople(account_id, contact_id)')
    expect(read('app/api/crm/admin-actions/delete-contact/route.ts')).toContain('companiesLeftWithOnlyMarkedPeople(contact_id)')
  })
})

describe('a failed welcome email shows on the job step', () => {
  it('the step is an error and names each person', () => {
    const src = read('lib/jobs/handlers/welcome-package-setup.ts')
    expect(src).toContain('counts.errors > 0 || counts.emailFailures.length > 0 ? "error" : "ok"')
    expect(src).toContain('welcome email(s) FAILED')
  })
})

describe('the other ways a signer could be switched to a marked person', () => {
  it('the SS-4 refresh and the CRM Generate SS-4 button refuse a marked signer', () => {
    expect(read('lib/operations/ss4-refresh.ts')).toContain('signerContactId !== row.contact_id && await isMarkedOnCompany(account_id, signerContactId)')
    expect(read('app/api/crm/admin-actions/generate-document/route.ts')).toContain('isMarkedOnCompany(accountId, responsibleContact.id)')
  })
})

describe('the removal guard only applies while the switch is on for the company', () => {
  it('asks the switch first', () => {
    expect(read('lib/members/removal-guard.ts')).toContain('memberPortalAccessOn({ accountId })')
  })
})

describe('the Bug Hunter\'s review of the fixes (21 Nov 2026)', () => {
  it('an Operating Agreement co-signer who is marked still gets their personal signing-link email', () => {
    const src = read('lib/portal/action-required.ts')
    expect(src).toContain('if (markedNamed && !params.emailLink)')
    expect(src).toContain('if (markedNamed) {\n      result.chat = companyChannelsOff')
  })
  it('a stage notice whose contact is marked is redirected to the company, not dropped', () => {
    const src = read('lib/service-delivery.ts')
    expect(src).toContain('const stageContactId: string | null =')
    expect(occurrences(src, 'stageContactId ?? undefined')).toBe(2)
  })
  it('Take away checks that a keeper can really sign in, and fails closed', () => {
    const src = read('lib/members/staff-portal-access.ts')
    expect(src).toContain('deps.canSignIn(info.email, id)')
    expect(src).toContain('throw new Error(`Could not check the SS-4')
  })
})
