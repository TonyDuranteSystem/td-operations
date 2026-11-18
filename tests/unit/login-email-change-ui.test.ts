import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }))

import { ChangeLoginEmailDialog } from '@/components/portal/change-login-email-dialog'
import { LoginEmailRow } from '@/components/portal/login-email-row'
import { UndoEmailChangeForm } from '@/components/portal/undo-email-change-form'
import { ProfileEditor } from '@/components/portal/profile-editor'
import { WizardField, type FieldConfig } from '@/components/portal/wizard/wizard-field'

const profile = { first_name: 'Maria', last_name: 'Rossi', email: 'crm@example.com', phone: '', language: '', citizenship: '', address_line1: '', address_city: '', address_state: '', address_zip: '', address_country: '' }

describe('the Change login email dialog, first step', () => {
  const html = renderToStaticMarkup(createElement(ChangeLoginEmailDialog, { currentEmail: 'maria.rossi@example.com', onClose: () => undefined }))
  it('shows the login email today (locked), the two boxes and the big red block', () => {
    expect(html).toContain('Step 1 of 3')
    expect(html).toContain('Change your login email')
    expect(html).toContain('maria.rossi@example.com')
    expect(html).toContain('data-testid="cle-new-email"')
    expect(html).toContain('data-testid="cle-password"')
    expect(html).toContain('Read well before proceeding.')
    expect(html).toContain('I read it')
    expect(html).toContain('data-must-read')
    expect(html).toContain('We will send a 6-digit code to the new address.')
  })
  it('draws the Send code button grey (and still a real, clickable button) until the box is ticked', () => {
    const btn = html.slice(html.indexOf('data-testid="cle-send-code"') - 400, html.indexOf('data-testid="cle-send-code"') + 400)
    expect(btn).toContain('bg-zinc-200')
    expect(btn).not.toContain('disabled=""')
    expect(btn).toContain('Send code')
  })
})

describe('the profile', () => {
  it('shows a Login email row with a Change button when the login is known', () => {
    const html = renderToStaticMarkup(createElement(ProfileEditor, { contactId: 'c1', initialData: profile, loginEmail: 'login@example.com' }))
    expect(html).toContain('data-testid="profile-login-email"')
    expect(html).toContain('login@example.com')
    expect(html).toContain('Login email')
    expect(html).toContain('Change email')
    expect(html).toContain('You use this email to log in.')
    expect(html).not.toContain('crm@example.com')
  })
  it('keeps the old read-only Email for a login without a contact', () => {
    const html = renderToStaticMarkup(createElement(ProfileEditor, { contactId: 'c1', initialData: profile }))
    expect(html).not.toContain('data-testid="profile-login-email"')
    expect(html).toContain('crm@example.com')
  })
  it('the row on its own', () => {
    const html = renderToStaticMarkup(createElement(LoginEmailRow, { loginEmail: 'a@b.co' }))
    expect(html).toContain('a@b.co')
    expect(html).toContain('data-testid="profile-change-login-email"')
  })
})

describe('the locked Email box in the formation form', () => {
  const field: FieldConfig = { name: 'owner_email', label: 'Email', type: 'email', required: true }
  const render = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(WizardField, { field, value: 'a@b.co', onChange: () => undefined, locale: 'en', locked: true, ...extra } as never))
  it('offers "Change login email" (a button) when the client can change it from the form', () => {
    const html = render({ onChangeLocked: () => undefined })
    expect(html).toContain('data-testid="wizard-change-login-email"')
    expect(html).toContain('Change login email')
    expect(html).not.toContain('message us in chat')
  })
  it('in Italian too', () => {
    expect(renderToStaticMarkup(createElement(WizardField, { field, value: 'a@b.co', onChange: () => undefined, locale: 'it', locked: true, onChangeLocked: () => undefined } as never))).toContain('Cambia email di accesso')
  })
  it('falls back to the old "message us in chat" link when it cannot', () => {
    const html = render({})
    expect(html).toContain('message us in chat')
    expect(html).not.toContain('wizard-change-login-email')
  })
})

describe('the "This wasn\'t me" page', () => {
  it('a good link: says which email comes back, asks a new password and shows the big red block', () => {
    const html = renderToStaticMarkup(createElement(UndoEmailChangeForm, { token: 't', lang: 'en', restoreEmail: 'maria.rossi@example.com' }))
    expect(html).toContain('We will put your old email back')
    expect(html).toContain('maria.rossi@example.com')
    expect(html).toContain('Read well before proceeding.')
    expect(html).toContain('The new email stops working as a login.')
    expect(html).toContain('data-testid="undo-password"')
    expect(html).toContain('Put my old email back')
    expect(html).toContain('bg-zinc-200')
  })
  it('Italian', () => {
    const html = renderToStaticMarkup(createElement(UndoEmailChangeForm, { token: 't', lang: 'it', restoreEmail: 'maria.rossi@example.com' }))
    expect(html).toContain('Rimetteremo la tua vecchia email')
    expect(html).toContain('Leggi bene prima di continuare.')
  })
  it('a bad, used or expired link shows one plain message and no form, and never says why', () => {
    const html = renderToStaticMarkup(createElement(UndoEmailChangeForm, { token: 'x', lang: 'en', restoreEmail: null }))
    expect(html).toContain('data-testid="undo-bad-link"')
    expect(html).toContain('This link has already been used or has expired.')
    expect(html).not.toContain('undo-password')
  })
})
