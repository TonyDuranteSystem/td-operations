import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { t } from '@/lib/portal/i18n'
import { refusal } from '@/lib/portal/login-email-change-http'

const ROOT = join(__dirname, '..', '..')

describe('every refusal has a status, a code and plain words', () => {
  const codes = ['invalid_email', 'same_email', 'wrong_password', 'email_unavailable', 'too_many_passwords', 'too_many_starts', 'locked', 'too_many_codes', 'wait', 'wrong_code', 'expired', 'not_found', 'busy', 'mail_failed', 'failed', 'not_allowed', 'rate_limited', 'invalid', 'used', 'superseded', 'short', 'mismatch']
  for (const code of codes) {
    it(code, async () => {
      const res = refusal(code, { retryAfterSeconds: 30 })
      expect(res.status).toBeGreaterThanOrEqual(400)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.code).toBe(code)
      expect(String(body.error).length).toBeGreaterThan(10)
      expect(res.headers.get('Retry-After')).toBe('30')
    })
  }
  it('an unknown code falls back to the generic failure, never to silence', async () => {
    const res = refusal('something_new')
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('something_new')
  })
  it('an unavailable email never says whose it is', async () => {
    const body = await refusal('email_unavailable').json()
    expect(body.error).toBe("We can't use this email. Try a different one, or message us and we will help.")
  })
})

describe('the portal text for the dialog exists in English and Italian, with the same placeholders', () => {
  const keys = [
    'title', 'help', 'change', 'changeLink', 'step', 'dialogTitle', 'today', 'newEmail', 'password', 'passwordHint', 'readTitle', 'readBody', 'readStrong', 'iReadIt', 'tickToContinue',
    'sendCode', 'cancel', 'codeTitle', 'codeSent', 'codeLabel', 'noEmail', 'resend', 'resendIn', 'resent', 'goBack', 'confirm', 'doneTitle', 'doneLogin', 'donePassword', 'doneNote', 'done',
    'err.invalid_email', 'err.same_email', 'err.wrong_password', 'err.email_unavailable', 'err.wrong_code', 'err.expired', 'err.locked', 'err.too_many_passwords', 'err.too_many_starts', 'err.too_many_codes',
    'err.wait', 'err.not_found', 'err.not_allowed', 'err.mail_failed', 'err.busy', 'err.failed', 'err.fillAll', 'err.sixDigits',
  ]
  const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(',')
  for (const k of keys) {
    it(`loginEmail.${k}`, () => {
      const key = `loginEmail.${k}`
      const en = t(key, 'en')
      const it_ = t(key, 'it')
      expect(en).not.toBe(key)
      expect(it_).not.toBe(key)
      expect(it_).not.toBe(en)
      expect(placeholders(it_)).toBe(placeholders(en))
    })
  }
  it('every error code the routes can send has its own words in the dialog', () => {
    const wanted = ['invalid_email', 'same_email', 'wrong_password', 'email_unavailable', 'wrong_code', 'expired', 'locked', 'too_many_passwords', 'too_many_starts', 'too_many_codes', 'wait', 'not_found', 'not_allowed', 'mail_failed', 'busy', 'failed']
    for (const c of wanted) expect(t(`loginEmail.err.${c}`, 'en')).not.toBe(`loginEmail.err.${c}`)
  })
})

describe('the middleware', () => {
  const src = readFileSync(join(ROOT, 'middleware.ts'), 'utf8')
  const list = src.slice(src.indexOf('const PUBLIC_PREFIXES = ['), src.indexOf(']', src.indexOf('const PUBLIC_PREFIXES = [')))
  it('lets a logged-out person open the "This wasn\'t me" page and its action', () => {
    expect(list).toContain("'/portal/undo-email-change'")
    expect(list).toContain("'/api/portal/undo-email-change'")
  })
  it('does NOT make the three logged-in change routes public', () => {
    for (const path of ['/api/portal/login-email/start', '/api/portal/login-email/resend', '/api/portal/login-email/confirm']) {
      const prefixes = Array.from(list.matchAll(/'([^']+)'/g)).map((m) => m[1])
      expect(prefixes.some((p) => path.startsWith(p)), path).toBe(false)
    }
  })
})
