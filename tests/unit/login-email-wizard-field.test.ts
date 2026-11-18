import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WizardField, type FieldConfig } from '@/components/portal/wizard/wizard-field'
import { MustReadBlock } from '@/components/portal/must-read-block'
import { FORMATION_FIELDS, ONBOARDING_FIELDS, getWizardConfig } from '@/components/portal/wizard/wizard-configs'
import { getWizardTranslatableText } from '@/lib/portal/wizard-translatable-text'

const ownerEmail = (): FieldConfig => {
  const f = FORMATION_FIELDS.owner.find(x => x.name === 'owner_email')
  if (!f) throw new Error('owner_email missing from the formation Owner step')
  return f
}

function render(props: Partial<Parameters<typeof WizardField>[0]> & { field: FieldConfig }): string {
  return renderToStaticMarkup(
    createElement(WizardField, {
      value: 'maria@example.com',
      onChange: () => undefined,
      locale: 'en',
      ...props,
    }),
  )
}

describe('MustReadBlock — the one shared big red warning', () => {
  const html = (checked: boolean, invalid = false) =>
    renderToStaticMarkup(
      createElement(MustReadBlock, { title: 'Read well before proceeding.', ackLabel: 'I read it', checked, invalid, onCheckedChange: () => undefined }, createElement('p', null, 'Important words')),
    )

  it('shows the big title, the message and the "I read it" tick', () => {
    const out = html(false)
    expect(out).toContain('Read well before proceeding.')
    expect(out).toContain('Important words')
    expect(out).toContain('I read it')
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('data-must-read')
  })
  it('draws the tick as ticked only when it is', () => {
    expect(html(false)).not.toContain('checked=""')
    expect(html(true)).toContain('checked=""')
  })
  it('rings the block only when not ticked and the client already tried to go on', () => {
    expect(html(false, true)).toContain('ring-4')
    expect(html(true, true)).not.toContain('ring-4')
    expect(html(false, false)).not.toContain('ring-4')
  })
})

describe('the owner Email box in WizardField', () => {
  it('locked: shows the login email read-only, the locked label, the lock and the way to ask for a change', () => {
    const out = render({ field: ownerEmail(), locked: true })
    expect(out).toContain('Email (your portal login)')
    expect(out).toContain('maria@example.com')
    expect(out).toContain('disabled')
    expect(out).toContain('readOnly'.toLowerCase())
    expect(out).toContain('To change it, message us in chat.')
    expect(out).toContain('href="/portal/chat"')
  })

  it('shows the big red block with the key sentence and the second note only when asked', () => {
    const plain = render({ field: ownerEmail(), locked: true })
    expect(plain).toContain('Read well before proceeding.')
    expect(plain).toContain('This is the email you use to log in to the client portal.')
    expect(plain).toContain('It is the official email for your account.')
    expect(plain).not.toContain('You already have a portal.')

    const second = render({ field: ownerEmail(), locked: true, showExtraNote: true })
    expect(second).toContain('You already have a portal. Keep using this same email for your new company.')
    expect(second).toContain('One login lets you switch between your companies from the top bar.')
  })

  it('reads the tick from the answers under owner_email_read', () => {
    expect(render({ field: ownerEmail(), locked: true, context: {} })).not.toContain('checked=""')
    expect(render({ field: ownerEmail(), locked: true, context: { owner_email_read: true } })).toContain('checked=""')
  })

  it('speaks Italian to an Italian client', () => {
    const out = render({ field: ownerEmail(), locked: true, showExtraNote: true, locale: 'it' })
    expect(out).toContain('Email (il tuo accesso al portale)')
    expect(out).toContain('Leggi bene prima di procedere.')
    expect(out).toContain('Ho letto')
    expect(out).toContain('Per cambiarla, scrivici in chat.')
    expect(out).toContain('Hai già un portale.')
  })

  it('a box that is not locked (a team login) keeps the old plain Email box', () => {
    // The wizard strips mustRead from a field it did not lock; the field itself then renders as before.
    const field: FieldConfig = { ...ownerEmail(), mustRead: undefined }
    const out = render({ field, locked: false, value: 'typed@example.com' })
    expect(out).toContain('>Email<')
    expect(out).not.toContain('Email (your portal login)')
    expect(out).not.toContain('Read well before proceeding.')
    expect(out).not.toContain('To change it, message us in chat.')
    expect(out).not.toContain('disabled')
  })

  it('shows a missing-tick message under the block', () => {
    const out = render({ field: ownerEmail(), locked: true, error: 'Tick "I read it" to continue.' })
    expect(out).toContain('ring-4')
    expect(out).toContain('to continue.')
  })
})

describe('where the login-email rule lives in the configs', () => {
  it('both the formation and the onboarding Owner step carry the must-read block on owner_email', () => {
    const onboardingOwner = ONBOARDING_FIELDS.owner.find(f => f.name === 'owner_email')
    for (const f of [ownerEmail(), onboardingOwner]) {
      expect(f?.mustRead?.lead).toBe('This is the email you use to log in to the client portal.')
      expect(f?.lockedLabel).toBe('Email (your portal login)')
      expect(f?.mustRead?.extraLead).toContain('Keep using this same email')
    }
  })
  it('the other wizards (tax) keep their plain Email box', () => {
    const { fields } = getWizardConfig('tax', 'SMLLC')
    const taxOwner = Object.values(fields).flat().find(f => f.name === 'owner_email')
    expect(taxOwner).toBeDefined()
    expect(taxOwner?.mustRead).toBeUndefined()
    expect(taxOwner?.lockedLabel).toBeUndefined()
  })
})

describe('translation of the new wording', () => {
  const text = getWizardTranslatableText()
  it('sends every new English sentence to the translator', () => {
    for (const s of [
      'Email (your portal login)',
      'This is the email you use to log in to the client portal.',
      'It is the official email for your account.',
      'You already have a portal. Keep using this same email for your new company.',
      'One login lets you switch between your companies from the top bar.',
      'Read well before proceeding.',
      'I read it',
      'To change it, message us in chat.',
      'Tick "I read it" to continue.',
    ]) {
      expect(text[s], s).toBe(s)
    }
  })
})
