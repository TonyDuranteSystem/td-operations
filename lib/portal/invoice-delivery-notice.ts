/**
 * Tell the client when an invoice email did not reach THEIR customer (found out afterwards from Resend's webhook).
 * Uses the standard "the client must act" dispatch (lib/portal/action-required.ts): a portal chat message, an immediate
 * bilingual email, and the bell + push, with its own double-send guard. It never throws.
 */
import { notifyClientActionRequired, type LocalizedText } from '@/lib/portal/action-required'
import { deliveryReasonKey } from '@/lib/portal/delivery-reason'

const REASON: Record<'suppressed' | 'bounced' | 'failed', LocalizedText> = {
  suppressed: {
    en: 'That address is currently blocked by our email service, because mail to it recently failed. This can clear by itself within about two weeks.',
    it: 'Quell\'indirizzo è al momento bloccato dal nostro servizio email, perché i messaggi inviati di recente non sono arrivati. Può sbloccarsi da solo entro circa due settimane.',
  },
  bounced: {
    en: 'The customer\'s mail server rejected it. The address may be misspelled, closed or full.',
    it: 'Il server di posta del cliente l\'ha rifiutata. L\'indirizzo potrebbe essere sbagliato, chiuso o pieno.',
  },
  failed: {
    en: 'The email could not be sent.',
    it: 'Non è stato possibile inviare l\'email.',
  },
}

export function buildDeliveryNotice(opts: {
  invoiceNumber: string
  customerName: string | null
  to: string | null
  detail: string | null
}): { title: LocalizedText; message: LocalizedText; ctaLabel: LocalizedText } {
  const reason = REASON[deliveryReasonKey(opts.detail)]
  const who = opts.customerName ? `${opts.customerName}${opts.to ? ` (${opts.to})` : ''}` : (opts.to ?? 'your customer')
  return {
    title: {
      en: `Invoice ${opts.invoiceNumber} did not reach your customer`,
      it: `La fattura ${opts.invoiceNumber} non è arrivata al tuo cliente`,
    },
    message: {
      en: `The email with invoice ${opts.invoiceNumber} to ${who} could not be delivered. ${reason.en} What you can do: check the email address, then send it again, or download the PDF and send it yourself.`,
      it: `L'email con la fattura ${opts.invoiceNumber} a ${who} non è stata consegnata. ${reason.it} Cosa puoi fare: controlla l'indirizzo email, poi invia di nuovo, oppure scarica il PDF e invialo tu.`,
    },
    ctaLabel: { en: 'Open the invoice', it: 'Apri la fattura' },
  }
}

export async function notifyInvoiceNotDelivered(opts: {
  accountId: string
  invoiceId: string
  invoiceNumber: string
  customerName: string | null
  to: string | null
  detail: string | null
}): Promise<void> {
  const copy = buildDeliveryNotice(opts)
  await notifyClientActionRequired({
    account_id: opts.accountId,
    title: copy.title,
    message: copy.message,
    ctaLabel: copy.ctaLabel,
    // One link per invoice: it is also the double-send guard's scope, so two different invoices both notify.
    link: `/portal/invoices/${opts.invoiceId}`,
  })
}
