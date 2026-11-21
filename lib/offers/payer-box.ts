/**
 * The "Is someone else paying?" box on the client's payment page
 * (dev job e62bc2b6, Antonio 2026-11-21).
 *
 * ONE implementation, built with plain DOM calls (text only, never innerHTML), because the
 * contract pages draw their payment step two ways — React for one, hand-built HTML for the
 * others. Each of them gives this function an empty element and the offer's credential.
 *
 * The client types WHO PAYS (name, address, country, VAT). The invoice is then addressed to
 * that payer; the invoice email still goes to the person who signed. The client can never
 * pick one of our companies here — see lib/offers/client-payer.ts.
 *
 * Client-safe: no server imports. Hides itself (never breaks the page) when it is not
 * available: not signed yet, a staff preview, or any error loading.
 */
import { fetchClientPayer, submitClientPayer, type ClientPayerView, type OfferCredential } from '@/lib/offers/offer-api-client'

const TEXT = {
  en: {
    toggle: 'Is someone else paying? Tell us who',
    help: 'If the payment will not come from you (for example your other company, a family member, or a company that is already our client), write who is paying. The invoice will show their name. We still send the invoice to you.',
    name: 'Who is paying *',
    address: 'Address',
    country: 'Country',
    vat: 'VAT / tax code',
    save: 'Save',
    saving: 'Saving…',
    saved: (n: string) => `Saved. The invoice will be addressed to ${n}.`,
    current: (n: string) => `The invoice is addressed to: ${n}`,
    change: 'Change',
    needName: 'Please enter the name of who is paying.',
    fail: 'We could not save this. Please try again.',
  },
  it: {
    toggle: 'Paga qualcun altro? Dicci chi',
    help: "Se il pagamento non arriverà da te (per esempio da un'altra tua società, da un familiare o da una società già nostra cliente), scrivi chi paga. La fattura riporterà il suo nome. La fattura continuerà a essere inviata a te.",
    name: 'Chi paga *',
    address: 'Indirizzo',
    country: 'Paese',
    vat: 'P.IVA / codice fiscale',
    save: 'Salva',
    saving: 'Salvataggio…',
    saved: (n: string) => `Salvato. La fattura sarà intestata a ${n}.`,
    current: (n: string) => `La fattura è intestata a: ${n}`,
    change: 'Modifica',
    needName: 'Inserisci il nome di chi paga.',
    fail: 'Non siamo riusciti a salvare. Riprova.',
  },
} as const

const MAX = { name: 120, address: 200, country: 80, vat: 40 }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (style) e.setAttribute('style', style)
  if (text) e.textContent = text
  return e
}

/** Draws the box into `container`. Returns a cleanup function. */
export function mountPayerBox(container: HTMLElement, cred: OfferCredential, lang: string | null | undefined): () => void {
  const t = lang === 'it' ? TEXT.it : TEXT.en
  let cancelled = false
  container.textContent = ''

  fetchClientPayer(cred)
    .then((view: ClientPayerView) => {
      if (cancelled || !view.available) return
      render(view)
    })
    .catch(() => { /* not available (preview, error): show nothing, never break the page */ })

  function render(view: ClientPayerView) {
    container.textContent = ''
    const box = el('div', 'margin:18px 0 6px;text-align:left;')
    container.appendChild(box)

    const currentLine = el('div', 'font-size:10.5pt;color:var(--c-muted,#666);margin-bottom:6px;')
    const toggle = el('button', 'background:none;border:none;padding:0;color:var(--c-blue,#1d4ed8);font-size:10.5pt;text-decoration:underline;cursor:pointer;font-family:inherit;', t.toggle)
    toggle.type = 'button'
    toggle.setAttribute('data-testid', 'payer-toggle')
    const form = el('div', 'display:none;margin-top:10px;padding:14px;border:1px solid var(--c-border,#ddd);border-radius:8px;background:#fafafa;')
    form.setAttribute('data-testid', 'payer-form')
    const help = el('p', 'font-size:9.5pt;color:var(--c-muted,#666);margin:0 0 10px;line-height:1.5;', t.help)
    form.appendChild(help)

    const inputs: Record<'name' | 'address' | 'country' | 'vat_number', HTMLInputElement> = {
      name: field(t.name, MAX.name, 'payer-name'),
      address: field(t.address, MAX.address, 'payer-address'),
      country: field(t.country, MAX.country, 'payer-country'),
      vat_number: field(t.vat, MAX.vat, 'payer-vat'),
    }
    function field(label: string, max: number, testid: string): HTMLInputElement {
      const wrap = el('label', 'display:block;margin-bottom:8px;font-size:9.5pt;color:var(--c-muted,#666);')
      wrap.appendChild(el('span', 'display:block;margin-bottom:3px;', label))
      const input = el('input', 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--c-border,#ccc);border-radius:6px;font-size:11pt;font-family:inherit;')
      input.type = 'text'
      input.maxLength = max
      input.setAttribute('data-testid', testid)
      wrap.appendChild(input)
      form.appendChild(wrap)
      return input
    }
    if (view.payer) {
      inputs.name.value = view.payer.name
      inputs.address.value = view.payer.address ?? ''
      inputs.country.value = view.payer.country ?? ''
      inputs.vat_number.value = view.payer.vat_number ?? ''
    }

    const save = el('button', 'padding:9px 18px;border:none;border-radius:6px;background:var(--c-green,#15803d);color:#fff;font-size:10.5pt;font-weight:600;cursor:pointer;font-family:inherit;', t.save)
    save.type = 'button'
    save.setAttribute('data-testid', 'payer-save')
    const status = el('div', 'font-size:9.5pt;margin-top:8px;')
    status.setAttribute('data-testid', 'payer-status')
    form.appendChild(save)
    form.appendChild(status)

    function showCurrent(name: string | null) {
      currentLine.textContent = name ? t.current(name) : ''
      currentLine.style.display = name ? 'block' : 'none'
    }
    showCurrent(view.payer?.name ?? null)
    currentLine.setAttribute('data-testid', 'payer-current')

    box.appendChild(currentLine)
    // Paid already: show who the invoice is addressed to, but no way to change it here.
    if (!view.editable) return
    toggle.textContent = view.payer ? t.change : t.toggle
    box.appendChild(toggle)
    box.appendChild(form)

    toggle.addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? 'block' : 'none'
    })

    save.addEventListener('click', () => {
      const name = inputs.name.value.trim()
      status.textContent = ''
      if (name.length < 2) {
        status.style.color = 'var(--c-red,#b91c1c)'
        status.textContent = t.needName
        return
      }
      save.disabled = true
      save.textContent = t.saving
      submitClientPayer(cred, {
        name,
        address: inputs.address.value.trim(),
        country: inputs.country.value.trim(),
        vat_number: inputs.vat_number.value.trim(),
      })
        .then(() => {
          if (cancelled) return
          status.style.color = 'var(--c-green,#15803d)'
          status.textContent = t.saved(name)
          showCurrent(name)
          toggle.textContent = t.change
        })
        .catch((e: unknown) => {
          if (cancelled) return
          status.style.color = 'var(--c-red,#b91c1c)'
          status.textContent = e instanceof Error && e.message ? e.message : t.fail
        })
        .finally(() => {
          save.disabled = false
          save.textContent = t.save
        })
    })
  }

  return () => { cancelled = true; container.textContent = '' }
}
