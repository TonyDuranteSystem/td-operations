'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { isClientFacingError } from '@/lib/public-forms/signing-failures'
import { uploadAndSignOffer, submitWireReceipt, type OfferCredential } from '@/lib/offers/offer-api-client'
import type { Offer } from '@/lib/types/offer'
import { contractVersionLabel } from '@/lib/offers/contract-version'
import { euroBankAddress } from '@/lib/offers/bank-address'
import { isBuiltInAgreementType, isCustomContractType, type ShortContractType } from '@/lib/offers/standalone-contract-types'
import { wordingFromSnapshot, type ContractWording } from '@/lib/contracts/contract-wording'
import { planAgreements } from '@/lib/offers/standalone-agreement-lines'
import { AgreementBody, contractToday } from '@/components/contracts/agreement-body'

const today = contractToday

function esc(v: string) {
  const d = document.createElement('div')
  d.textContent = v
  return d.innerHTML
}

interface StandaloneServiceAgreementProps {
  offer: Offer
  token: string
  contractType?: ShortContractType
  /** The offer's access code (N0) — every write goes through /api/offers with it. */
  cred: OfferCredential
}

// Service-specific content based on contract type — exported for inline addon rendering
export const SERVICE_CONTENT = {
  tax_return: {
    title: 'Tax Return Filing Agreement',
    shortTitle: 'Tax Return Filing Agreement',
    pdfPrefix: 'Tax_Agreement',
    scope: {
      intro: "The Service Provider agrees to prepare and file the Client's LLC federal tax return for the tax year specified above. This includes:",
      items: [
        'Preparation of the applicable IRS form(s) based on the LLC type;',
        'Electronic filing (e-filing) of the tax return with the IRS;',
        'Filing of a tax extension (Form 7004) if the return cannot be completed before the original deadline;',
        'Signature by a Certified Tax Preparer (PTIN holder).',
      ],
      closing: 'This Agreement covers one (1) tax return filing for the specified tax year only. Any additional tax years or services require a separate agreement.',
    },
    procedure: {
      intro: 'The tax return preparation follows this process:',
      steps: [
        { title: 'Data Collection', desc: 'The Service Provider sends the Client a tax intake form to gather all necessary LLC information and financial data.' },
        { title: 'Extension Filing', desc: 'If the original filing deadline (typically March 15 for partnerships, April 15 for corporations) has passed or insufficient time remains, the Service Provider files an automatic extension (Form 7004), extending the deadline to September 15 or October 15 respectively.' },
        { title: 'Preparation', desc: 'The Service Provider prepares the tax return based on the data provided by the Client.' },
        { title: 'Review & Approval', desc: 'The completed return is sent to the Client for review before filing.' },
        { title: 'Filing', desc: 'Upon Client approval, the return is electronically filed with the IRS. The Client receives confirmation of acceptance.' },
      ],
    },
    commitments: [
      'Prepare the tax return in compliance with applicable IRS rules and regulations;',
      'File a tax extension on behalf of the Client if the return cannot be completed before the original deadline, ensuring no late-filing penalties;',
      'Complete and file the tax return within a reasonable timeframe after receiving all required data from the Client;',
      'Provide the Client with a copy of the filed return and IRS acceptance confirmation.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Provide accurate and complete financial data', rest: ' for the LLC, including but not limited to: income, expenses, bank statements, and any other records required for the tax return;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request;' },
        { bold: 'Certify the accuracy', rest: " of all information provided. The Service Provider relies on the Client's data and is not responsible for errors resulting from incomplete or inaccurate information;" },
        { bold: 'Notify the Service Provider promptly', rest: ' of any changes to the LLC structure, ownership, or financial activity that may affect the tax return.' },
      ],
    },
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Tax Return Filing Agreement. I acknowledge my responsibility to provide accurate and complete financial data for the tax return preparation.',
    successNote: 'Once payment is received, we will begin working on your tax return immediately.',
  },
  itin: {
    title: 'ITIN Application Service Agreement',
    shortTitle: 'ITIN Application Service Agreement',
    pdfPrefix: 'ITIN_Agreement',
    scope: {
      intro: 'The Service Provider agrees to prepare and submit the ITIN application on behalf of the Client. This includes:',
      items: [
        'Preparation of IRS Form W-7 (Application for IRS Individual Taxpayer Identification Number);',
        'Preparation of a supporting federal tax return (Form 1040-NR) as required by the IRS;',
        'Review and certification by a Certified Acceptance Agent (CAA);',
        'Submission of the complete application package to the IRS via certified mail.',
      ],
      closing: 'This Agreement covers one (1) ITIN application only. Any additional applications or services require a separate agreement.',
    },
    procedure: {
      intro: 'The ITIN application process follows these steps:',
      steps: [
        { title: 'Data Collection', desc: 'The Service Provider sends the Client a secure intake form to collect personal information, passport details, and foreign address.' },
        { title: 'Document Preparation', desc: 'The Service Provider prepares Form W-7 and the supporting Form 1040-NR based on the data provided.' },
        { title: 'CAA Review', desc: 'A Certified Acceptance Agent reviews and certifies the application, verifying the Client\'s identity documents (passport).' },
        { title: 'Submission', desc: 'The complete application package is sent to the IRS via certified mail with tracking.' },
        { title: 'Follow-up', desc: 'The Service Provider monitors the application status. The IRS typically processes ITIN applications within 7-11 weeks.' },
      ],
    },
    commitments: [
      'Prepare the W-7 and 1040-NR forms in compliance with applicable IRS rules and regulations;',
      'Ensure the application is reviewed and certified by a Certified Acceptance Agent (CAA);',
      'Submit the application to the IRS via certified mail with tracking;',
      'Provide the Client with the ITIN number upon receipt from the IRS.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Provide accurate and complete personal information', rest: ', including full legal name, date of birth, country of citizenship, and foreign address;' },
        { bold: 'Provide a valid passport', rest: ' (or certified copy) for identity verification by the Certified Acceptance Agent;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request;' },
        { bold: 'Acknowledge processing times', rest: ' are determined by the IRS (typically 7-11 weeks) and are outside the Service Provider\'s control.' },
      ],
    },
    workPhrase: 'the ITIN application',
    liabilityPhrase: "the IRS's decision on the application or its processing time, or for consequences",
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this ITIN Application Service Agreement. I acknowledge my responsibility to provide accurate and complete personal information for the application.',
    successNote: 'Once payment is received, we will begin preparing your ITIN application immediately.',
  },
  closure: {
    title: 'Company Closure Service Agreement',
    shortTitle: 'Company Closure Service Agreement',
    pdfPrefix: 'Closure_Agreement',
    scope: {
      intro: 'The Service Provider agrees to manage the complete closure of the Client\'s LLC on their behalf. This includes:',
      items: [
        'Filing of Articles of Dissolution (or equivalent) with the Secretary of State of the state where the LLC was formed;',
        'Notification to the IRS to close the LLC\'s EIN (Employer Identification Number) account;',
        'Cancellation of the registered agent service upon receipt of the official closure document from the Secretary of State;',
        'Delivery of the official state closure document to the Client by email.',
      ],
      closing: 'This Agreement covers the closure of one (1) LLC only. Any additional entities require a separate agreement.',
    },
    procedure: {
      intro: 'The company closure process follows these steps:',
      steps: [
        { title: 'Step 1 — Secretary of State Filing', desc: 'The Service Provider files the Articles of Dissolution (or equivalent document) with the Secretary of State of the state of formation. State processing times vary, typically 2–8 weeks. The LLC remains legally active until the state confirms dissolution.' },
        { title: 'Step 2 — EIN Closure at the IRS', desc: 'Once the state confirms dissolution, the Service Provider sends a written notification to the IRS requesting closure of the LLC\'s EIN account. Note: the EIN number itself is not deleted — the IRS account associated with it is closed.' },
        { title: 'Step 3 — Registered Agent Cancellation', desc: 'Upon receipt of the official closure document from the Secretary of State, the Service Provider cancels the registered agent service and delivers the official closure document to the Client by email.' },
      ],
    },
    commitments: [
      'File the dissolution paperwork with the Secretary of State within a reasonable timeframe after receiving the Client\'s signed authorization;',
      'Notify the IRS to close the EIN account upon confirmation of state dissolution;',
      'Cancel the registered agent service once the official closure document is received from the state;',
      'Deliver the official state closure document to the Client by email upon receipt.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Confirm the LLC has no outstanding debts, liabilities, or pending legal matters', rest: ' before authorizing the closure. The Service Provider is not responsible for resolving any existing obligations of the LLC;' },
        { bold: 'Ensure all LLC bank and payment processor accounts are closed', rest: ' or transferred before or during the closure process;' },
        { bold: 'Acknowledge that the closure process is irreversible', rest: ' once the state filing is submitted. The LLC will be legally dissolved and will cease to exist as a legal entity;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request.' },
      ],
    },
    workPhrase: 'the company closure',
    liabilityPhrase: 'the timing or outcome of any state or IRS processing of the closure, or for consequences',
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Company Closure Service Agreement. I authorize Tony Durante LLC to proceed with the dissolution of my LLC and acknowledge that this process is irreversible once the state filing is submitted.',
    successNote: 'Once payment is received, we will begin the closure process. You will receive the official closure documents from the Secretary of State by email.',
  },
  company_change_name: {
    title: 'Company Name Change Service Agreement',
    shortTitle: 'Company Name Change Service Agreement',
    pdfPrefix: 'Name_Change_Agreement',
    scope: {
      intro: 'The Service Provider agrees to manage the change of the legal name of the Client\'s existing LLC on their behalf. This includes:',
      items: [
        'Collecting up to three (3) proposed new company names from the Client and checking their availability with the Secretary of State of the state where the LLC was formed;',
        'Informing the Client which proposed name is available;',
        'Preparing and filing the name change form (Articles of Amendment or equivalent) with the Secretary of State;',
        'Delivering the official name change document received from the Secretary of State to the Client by email.',
      ],
      closing: 'This Agreement covers the name change of one (1) LLC only. Notifying the IRS, banks, payment processors and other third parties of the new name is not included unless purchased separately.',
    },
    procedure: {
      intro: 'The company name change follows these steps:',
      steps: [
        { title: 'Step 1 — Proposed Names', desc: 'The Client provides up to three (3) proposed new names for the LLC. The Service Provider checks their availability in order of preference.' },
        { title: 'Step 2 — Name Confirmation', desc: 'The Service Provider informs the Client which name is available. The Client confirms the name to be used before any filing is made.' },
        { title: 'Step 3 — State Filing', desc: 'The Service Provider prepares and files the name change form with the Secretary of State. State processing times vary and are outside the Service Provider\'s control. The LLC keeps its current name until the state approves the change.' },
        { title: 'Step 4 — Delivery', desc: 'When the Secretary of State returns the approved name change document, the Service Provider delivers it to the Client by email.' },
      ],
    },
    commitments: [
      'Check the availability of the proposed names with the Secretary of State;',
      'File the name change form within a reasonable timeframe after the Client confirms the new name;',
      'Deliver the official name change document to the Client by email upon receipt from the state.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Provide up to three (3) proposed names', rest: ' that comply with the naming rules of the state of formation;' },
        { bold: 'Understand that name availability is decided by the state', rest: ', and that a name found available may no longer be available at the time of filing;' },
        { bold: 'Update third parties', rest: ' (banks, payment processors, the IRS and others) with the new name, unless this service is purchased separately;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request.' },
      ],
    },
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Company Name Change Service Agreement. I authorize Tony Durante LLC to file the name change of my LLC with the Secretary of State.',
    successNote: 'Once payment is received, we will start the name change. You will receive the official name change document from the Secretary of State by email.',
    workPhrase: 'the name change work',
    liabilityPhrase: 'delays, rejections or additional fees charged by the Secretary of State, or for consequences',
  },
  ein_change_name: {
    title: 'EIN Name Change Service Agreement',
    shortTitle: 'EIN Name Change Service Agreement',
    pdfPrefix: 'EIN_Name_Change_Agreement',
    scope: {
      intro: 'The Service Provider agrees to request the update of the legal name on the Client\'s LLC EIN (Employer Identification Number) account with the IRS. This includes:',
      items: [
        'Preparing the IRS request to update the name on the LLC\'s EIN account (Form 8822-B, where applicable);',
        'Sending the request to the IRS;',
        'Following up with the IRS by phone to confirm that the request was received and processed;',
        'Informing the Client by email when the IRS has updated the name on the EIN account.',
      ],
      closing: 'This Agreement covers the EIN account of one (1) LLC only. It does not change the name of the LLC with the Secretary of State, which is a separate service.',
    },
    procedure: {
      intro: 'The EIN name change follows these steps:',
      steps: [
        { title: 'Step 1 — Preparation', desc: 'The Service Provider prepares the IRS request using the exact new legal name confirmed by the Client. The responsible party of the LLC signs where the IRS requires it.' },
        { title: 'Step 2 — Sending to the IRS', desc: 'The Service Provider sends the signed request to the IRS.' },
        { title: 'Step 3 — IRS Follow-up', desc: 'The Service Provider contacts the IRS by phone to confirm receipt and processing. IRS processing times vary and are outside the Service Provider\'s control.' },
        { title: 'Step 4 — Confirmation', desc: 'When the IRS confirms that the name on the EIN account has been updated, the Service Provider informs the Client by email.' },
      ],
    },
    commitments: [
      'Prepare and send the IRS request within a reasonable timeframe after receiving the Client\'s confirmed new name and any required signature;',
      'Follow up with the IRS until the request is processed or the IRS gives a final answer;',
      'Inform the Client by email of the outcome.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Confirm the exact new legal name', rest: ' of the LLC, as it appears (or will appear) on the Secretary of State record;' },
        { bold: 'Provide the signature and information the IRS requires', rest: ' from the LLC\'s responsible party;' },
        { bold: 'Acknowledge that processing times and the final decision belong to the IRS', rest: ', not to the Service Provider;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request.' },
      ],
    },
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this EIN Name Change Service Agreement. I authorize Tony Durante LLC to request the update of the name on my LLC\'s EIN account with the IRS.',
    successNote: 'Once payment is received, we will start the EIN name change. We will email you when the IRS confirms the update.',
    workPhrase: 'the EIN name change work',
    liabilityPhrase: 'delays or rejections by the IRS, or for consequences',
  },
  shipping: {
    title: 'Document Shipping Service Agreement',
    shortTitle: 'Document Shipping Service Agreement',
    pdfPrefix: 'Shipping_Agreement',
    scope: {
      intro: 'The Service Provider agrees to ship documents to the Client, or to the recipient named by the Client, on their behalf. This includes:',
      items: [
        'Preparing the shipment with the documents to be sent;',
        'Sending the shipment to the delivery address provided by the Client, with a carrier chosen by the Service Provider;',
        'Sending the Client the tracking number by email when the carrier provides one.',
      ],
      closing: 'This Agreement covers one (1) shipment only. Delivery times given by the carrier are estimates.',
    },
    procedure: {
      intro: 'The shipment follows these steps:',
      steps: [
        { title: 'Step 1 — Preparing the Shipment', desc: 'The Service Provider prepares the documents and checks the delivery address with the Client.' },
        { title: 'Step 2 — Shipped', desc: 'The Service Provider hands the shipment to the carrier and sends the Client the tracking number when available.' },
        { title: 'Step 3 — Delivered', desc: 'The shipment is complete when the carrier delivers it to the address provided.' },
      ],
    },
    commitments: [
      'Prepare and send the shipment within a reasonable timeframe after payment and after receiving a complete delivery address;',
      'Send the Client the tracking number by email when the carrier provides one.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Provide a complete and correct delivery address', rest: ', including a contact phone number where the carrier requires one;' },
        { bold: 'Make sure someone can receive the shipment', rest: ' at that address;' },
        { bold: 'Pay any customs duties, import taxes or local fees', rest: ' charged by the destination country, if any;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request.' },
      ],
    },
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Document Shipping Service Agreement. I authorize Tony Durante LLC to ship my documents to the delivery address I provided.',
    successNote: 'Once payment is received, we will prepare your shipment and email you the tracking number when it is available.',
    workPhrase: 'the shipping work',
    liabilityPhrase: 'delays, loss or damage caused by the carrier or customs, or for consequences',
  },
  public_notary: {
    title: 'Notary Service Agreement',
    shortTitle: 'Notary Service Agreement',
    pdfPrefix: 'Notary_Agreement',
    scope: {
      intro: 'The Service Provider agrees to notarize the Client\'s documents on their behalf. This includes:',
      items: [
        'Receiving the documents to be notarized from the Client;',
        'Notarizing the documents with a public notary;',
        'Returning the notarized documents to the Client.',
      ],
      closing: 'This Agreement covers the notarization of the documents listed in the offer only. The notary confirms the identity of the signer and the signature; the notary does not check or give advice on the content of the documents.',
    },
    procedure: {
      intro: 'The notarization follows these steps:',
      steps: [
        { title: 'Step 1 — Documents Received', desc: 'The Client sends the documents and the identification required for the notarization.' },
        { title: 'Step 2 — Notarized', desc: 'The documents are notarized by a public notary.' },
        { title: 'Step 3 — Returned to Client', desc: 'The Service Provider returns the notarized documents to the Client.' },
      ],
    },
    commitments: [
      'Notarize the documents within a reasonable timeframe after receiving them in complete form;',
      'Return the notarized documents to the Client.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Provide valid government-issued identification', rest: ' of every person who has to sign;' },
        { bold: 'Sign the documents as the notary requires', rest: ';' },
        { bold: 'Be responsible for the content of the documents', rest: ' and for their use in the country where they will be presented;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request.' },
      ],
    },
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Notary Service Agreement. I confirm that I am responsible for the content of the documents I submit for notarization.',
    successNote: 'Once payment is received, we will begin the notarization. We will return your notarized documents as soon as they are ready.',
    workPhrase: 'the notarization',
    liabilityPhrase: 'the acceptance of the documents by any third party or authority, or for consequences',
  },
  consulting_call: {
    title: 'Consulting Call Service Agreement',
    shortTitle: 'Consulting Call Service Agreement',
    pdfPrefix: 'Consulting_Call_Agreement',
    scope: {
      intro: 'The Service Provider agrees to hold a consulting call with the Client. This includes:',
      items: [
        'Scheduling the call at a time agreed with the Client;',
        'Holding the call with a Tony Durante LLC consultant on the topics agreed in advance;',
        'Following up by email on the next steps discussed, if any.',
      ],
      closing: 'This Agreement covers one (1) consulting call only. The call is general business consulting; it is not legal advice and does not create an attorney-client relationship. Any additional work requires a separate agreement.',
    },
    procedure: {
      intro: 'The consulting call follows these steps:',
      steps: [
        { title: 'Step 1 — To Schedule', desc: 'After payment, the Service Provider and the Client agree on a date and time.' },
        { title: 'Step 2 — Scheduled', desc: 'The Service Provider confirms the appointment with the Client by email.' },
        { title: 'Step 3 — Call Done', desc: 'The call is held at the scheduled time and the service is complete.' },
      ],
    },
    commitments: [
      'Offer the Client a call date within a reasonable timeframe after payment;',
      'Hold the call at the scheduled time with a qualified consultant;',
      'Follow up by email on the next steps discussed, if any.',
    ],
    clientDuties: {
      intro: 'The Client agrees to:',
      items: [
        { bold: 'Send the topics and the documents', rest: ' needed for the call before it takes place;' },
        { bold: 'Attend the call at the scheduled time', rest: ' and tell the Service Provider in advance if the time must change;' },
        { bold: 'Provide accurate and complete information', rest: ' about their situation;' },
        { bold: 'Respond to requests for information', rest: ' within five (5) business days of receiving the request.' },
      ],
    },
    signatureText: 'By signing below, I confirm that I have read and agree to the terms of this Consulting Call Service Agreement. I understand that the call is general business consulting and not legal advice.',
    successNote: 'Once payment is received, we will contact you by email to schedule your consulting call.',
    workPhrase: 'the consulting service',
    liabilityPhrase: 'decisions taken by the Client on the basis of the call, or for consequences',
  },
} as const

type AgreementContent = ContractWording

/**
 * The wording of one short contract: the eight built-in types live in SERVICE_CONTENT (code); a NEW service's
 * wording is the frozen copy on the offer (offers.contract_texts, taken when the offer was sent) — never the
 * live store. Null when there is none (the page then shows the "being prepared" notice, never a wrong contract).
 */
export function contractWordingFor(type: string, offer: { contract_texts?: unknown } | null | undefined): ContractWording | null {
  if (isBuiltInAgreementType(type)) return SERVICE_CONTENT[type]
  if (isCustomContractType(type)) return wordingFromSnapshot(offer?.contract_texts, type)
  return null
}

function phrasesFor(ct: AgreementContent) {
  // Per-type wording for the Payment / Liability sections (defaults = the tax-return text).
  const extra = ct as { workPhrase?: string; liabilityPhrase?: string }
  return {
    workPhrase: extra.workPhrase ?? 'the tax return preparation',
    liabilityPhrase: extra.liabilityPhrase ?? 'penalties, interest, or additional taxes',
  }
}

// Quantity-aware closing text for ITIN (Design B: one contract covers N members)
function scopeClosingFor(type: ShortContractType, ct: AgreementContent, service: { quantity?: number } | undefined): string {
  const itinQuantity = (type === 'itin' && service?.quantity && Number(service.quantity) > 1)
    ? Number(service.quantity)
    : null
  return type === 'itin' && itinQuantity
    ? `This Agreement covers up to ${itinQuantity} ITIN applications (one per member of the company). Each member's individual application is initiated separately through their own client portal dashboard. Any applications beyond ${itinQuantity} require a separate agreement.`
    : ct.scope.closing
}

/** Shown instead of a contract that cannot be rendered (its wording is missing). The client never sees a wrong or blank contract. */
export function ContractNotReady() {
  return (
    <div className="contract-section" data-contract-not-ready style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center' }}>
      <h2>Your agreement is being prepared</h2>
      <p style={{ textAlign: 'center' }}>We are finishing your agreement and will send it to you shortly. If you have any questions, please write to support@tonydurante.us.</p>
    </div>
  )
}

export default function StandaloneServiceAgreement(props: StandaloneServiceAgreementProps) {
  const { offer, contractType = 'tax_return' } = props
  const plan = planAgreements(offer, contractType, offer.multi_agreements === true)
  const types = plan.entries.length > 0 ? plan.entries.map((e) => e.type) : [contractType]
  if (types.some((t) => !contractWordingFor(t, offer))) return <ContractNotReady />
  return <StandaloneServiceAgreementPage {...props} />
}

function StandaloneServiceAgreementPage({ offer, token, contractType = 'tax_return', cred }: StandaloneServiceAgreementProps) {
  // What this page shows (lib/offers/standalone-agreement-lines.ts). The view route sets
  // `multi_agreements` from the switch; OFF (or absent) = the original single agreement.
  const plan = planAgreements(offer, contractType, offer.multi_agreements === true)
  const agreements = plan.entries
  const multi = plan.mode === 'multi'
  const mainType: ShortContractType = agreements[0]?.type ?? contractType
  const ct = contractWordingFor(mainType, offer) as ContractWording // the wrapper guarantees it exists
  const wording = (t: ShortContractType) => contractWordingFor(t, offer) as ContractWording
  const { workPhrase, liabilityPhrase } = phrasesFor(ct)
  const [signing, setSigning] = useState(false)
  // Blocking on a failed write makes RETRY a real path. The PDF-capture step
  // DESTRUCTIVELY rewrites the DOM (inputs -> spans, canvases -> imgs), so a
  // second attempt found `canvas.parentElement` null and threw a raw TypeError
  // onto a legal-signing screen. Freeze once; a retry reuses the frozen DOM.
  const frozenForPdfRef = useRef(false)
  const [statusMsg, setStatusMsg] = useState('Enter your name, email, and sign below.')
  const [statusType, setStatusType] = useState<'info' | 'error' | 'success'>('info')
  const [ready, setReady] = useState(false)
  const [name, setName] = useState(offer.client_name || '')
  const [email, setEmail] = useState(offer.client_email || '')
  const nameRef = useRef(name)
  const emailRef = useRef(email)
  useEffect(() => { nameRef.current = name }, [name])
  useEffect(() => { emailRef.current = email }, [email])

  const sigRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<any>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // The service this (single) agreement is for — chosen by planAgreements
  const service = agreements[0]?.line
  const serviceName = service?.name || 'Tax Return'
  const serviceDesc = service?.description || ''
  const fee = service?.price || ''
  const includes = service?.includes || []

  const scopeClosing = scopeClosingFor(mainType, ct, service)

  // The message after signing speaks for the whole document, not for the first service only.
  const successNote = multi ? 'Once payment is received, we will begin working on your services.' : ct.successNote
  const pdfName = multi ? 'Service_Agreements' : ct.pdfPrefix

  // Init signature pad
  useEffect(() => {
    const timer = setTimeout(async () => {
      const SignaturePad = (await import('signature_pad')).default
      const canvas = sigRef.current
      if (!canvas) return
      const ratio = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = canvas.offsetWidth * ratio
      canvas.height = canvas.offsetHeight * ratio
      canvas.getContext('2d')!.scale(ratio, ratio)
      const pad = new SignaturePad(canvas, { backgroundColor: 'rgba(255,255,255,0)', penColor: '#1a1a2e', minWidth: 1, maxWidth: 2.5 })
      pad.addEventListener('endStroke', () => checkReady())
      sigPadRef.current = pad
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const checkReady = useCallback(() => {
    const hasSig = sigPadRef.current && !sigPadRef.current.isEmpty()
    const ok = !!nameRef.current && !!emailRef.current && hasSig
    setReady(ok)
    if (!ok) {
      const m: string[] = []
      if (!nameRef.current) m.push('name')
      if (!emailRef.current) m.push('email')
      if (!hasSig) m.push('signature')
      setStatusMsg('Missing: ' + m.join(', '))
      setStatusType('info')
    } else {
      setStatusMsg('Ready to sign. Click the button below.')
      setStatusType('info')
    }
  }, [])

  useEffect(() => { checkReady() }, [name, email, checkReady])

  function clearSig() {
    if (sigPadRef.current) sigPadRef.current.clear()
    checkReady()
  }

  async function signAgreement() {
    if (signing) return
    setSigning(true)
    setStatusMsg('Generating PDF...')
    setStatusType('info')

    try {
      const html2pdf = (await import('html2pdf.js')).default

      if (!frozenForPdfRef.current) {
        frozenForPdfRef.current = true
      // Freeze form fields
      const formEl = document.getElementById('tax-client-form')
      if (formEl) {
        formEl.querySelectorAll('input').forEach(inp => {
          const td = inp.parentElement!
          td.innerHTML = `<span style="font-weight:500">${esc(inp.value)}</span>`
        })
      }

      // Replace canvas with image
      const canvas = sigRef.current
      if (canvas && sigPadRef.current) {
        const wrap = canvas.parentElement!
        const dataUrl = sigPadRef.current.toDataURL('image/png')
        wrap.innerHTML = `<img src="${dataUrl}" style="height:120px;display:block">`
      }

      }

      // Hide action bar
      const actionBar = document.getElementById('tax-action-bar')
      if (actionBar) actionBar.style.display = 'none'
      document.querySelectorAll('.contract-clear-btn').forEach(b => (b as HTMLElement).style.display = 'none')

      // Generate PDF
      const opt = {
        margin: [0.5, 0.6, 0.7, 0.6] as [number, number, number, number],
        filename: `Tony_Durante_${pdfName}_${token}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfBlob = await (html2pdf() as any).set(opt).from(bodyRef.current).outputPdf('blob')

      // N0 (dev job f907220c): upload through a one-time link, then the server checks the
      // PDF, writes the contracts row, flips the offer to signed and runs the follow-up.
      setStatusMsg('Uploading signed agreement...')
      await uploadAndSignOffer(cred, pdfBlob, `Tony_Durante_${pdfName}_${token}.pdf`, { client_name: name, client_email: email }, offer.language)

      // Show payment options — ensure real bank details (replace placeholders)
      const { ensureBankDetails } = await import('./bank-defaults')
      const bankDetails = offer.bank_details
        ? ensureBankDetails(offer.bank_details as Record<string, string>, offer.cost_summary as unknown[])
        : null
      const hasCard = offer.payment_links && offer.payment_links.length > 0
      const hasBank = !!bankDetails
      const successEl = document.getElementById('tax-success-state')

      if ((hasCard || hasBank) && successEl && bodyRef.current) {
        bodyRef.current.style.display = 'none'
        let sh = '<div class="contract-success-panel"><div class="contract-success-icon">&#10004;</div>'
        sh += `<h2 style="color:var(--c-green);font-size:18pt;margin-bottom:8px">${multi ? 'Agreements Signed!' : 'Agreement Signed!'}</h2>`
        sh += '<p style="font-size:12pt;margin-bottom:28px;color:var(--c-muted)">Choose how you want to pay:</p>'

        sh += '<div id="payment-choice">'
        if (hasCard) {
          const pl = offer.payment_links![0]
          sh += `<a href="${esc(pl.url)}" class="ps-choice-btn ps-choice-card" target="_blank" rel="noopener noreferrer">`
          sh += '<span class="ps-choice-icon">&#128179;</span>'
          sh += '<span class="ps-choice-label">Pay by Card</span>'
          sh += `<span class="ps-choice-price">${esc(pl.amount)}</span>`
          if (hasBank) sh += '<span class="ps-choice-badge">+5%</span>'
          sh += '</a>'
        }
        if (hasCard && hasBank) {
          sh += '<div class="post-sign-divider"><span>OR</span></div>'
        }
        if (hasBank) {
          sh += '<button id="choose-bank" class="ps-choice-btn ps-choice-bank" type="button">'
          sh += '<span class="ps-choice-icon">&#127974;</span>'
          sh += '<span class="ps-choice-label">Bank Transfer</span>'
          sh += `<span class="ps-choice-price">${esc(bankDetails!.amount || '')}</span>`
          sh += '</button>'
        }
        sh += '</div>'

        if (hasBank) {
          const b = bankDetails!
          sh += '<div id="bank-panel" style="display:none;">'
          sh += '<div class="post-sign-option">'
          sh += '<div class="post-sign-option-label">&#127974; Bank Transfer</div>'
          if (b.amount) sh += `<div class="post-sign-bank-amount">${esc(b.amount)}</div>`
          sh += '<div class="contract-bank-details-box"><h3>Bank Transfer Details</h3>'
          if (b.beneficiary) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Beneficiary</span><span class="contract-bank-value">${esc(b.beneficiary)}</span></div>`
          if (b.account_number) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Account Number</span><span class="contract-bank-value">${esc(b.account_number)}</span></div>`
          if (b.routing_number) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Routing Number</span><span class="contract-bank-value">${esc(b.routing_number)}</span></div>`
          if (b.iban) sh += `<div class="contract-bank-row"><span class="contract-bank-label">IBAN</span><span class="contract-bank-value">${esc(b.iban)}</span></div>`
          if (b.bic) sh += `<div class="contract-bank-row"><span class="contract-bank-label">BIC / SWIFT</span><span class="contract-bank-value">${esc(b.bic)}</span></div>`
          if (b.bank_name) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Bank</span><span class="contract-bank-value">${esc(b.bank_name)}</span></div>`
          if (euroBankAddress(b)) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Bank address</span><span class="contract-bank-value">${esc(euroBankAddress(b) as string)}</span></div>`
          if (b.reference) sh += `<div class="contract-bank-ref">Reference: ${esc(b.reference)}</div>`
          sh += '</div>'
          sh += '<div class="contract-receipt-upload">'
          sh += '<h3 style="font-size:11pt;margin-bottom:8px;">Upload Wire Transfer Receipt</h3>'
          sh += '<p style="font-size:9.5pt;color:var(--c-muted);margin-bottom:12px;">Once you complete the transfer, upload the receipt to start your services immediately.</p>'
          sh += '<div class="contract-receipt-drop" id="receipt-drop" onclick="document.getElementById(\'receipt-input\').click()">'
          sh += '<input type="file" id="receipt-input" accept="image/*,.pdf" style="display:none" />'
          sh += '<p id="receipt-label">Click to upload receipt (PDF or image)</p>'
          sh += '</div>'
          sh += '<button id="receipt-submit" class="contract-receipt-btn" disabled>Upload Receipt</button>'
          sh += '<div id="receipt-status" style="font-size:9pt;margin-top:8px;"></div>'
          sh += '</div></div></div>'
        }

        sh += `<p style="font-size:9.5pt;color:var(--c-muted);margin-top:24px;">${esc(successNote)}</p>`
        sh += `<a href="${esc(cred.code ? `/offer/${encodeURIComponent(token)}/${encodeURIComponent(cred.code)}` : `/offer/${encodeURIComponent(token)}`)}" class="contract-success-link">&larr; Back to Offer</a>`
        sh += '</div>'
        successEl.innerHTML = sh
        successEl.style.display = 'block'

        // Bank choice handler
        if (hasBank) {
          document.getElementById('choose-bank')?.addEventListener('click', () => {
            const choiceEl = document.getElementById('payment-choice')
            const bankEl = document.getElementById('bank-panel')
            if (choiceEl) choiceEl.style.display = 'none'
            if (bankEl) bankEl.style.display = 'block'
          })

          // Receipt upload handler
          const receiptInput = document.getElementById('receipt-input') as HTMLInputElement
          const receiptBtn = document.getElementById('receipt-submit') as HTMLButtonElement
          const receiptLabel = document.getElementById('receipt-label')!
          const receiptStatus = document.getElementById('receipt-status')!
          let receiptFile: File | null = null

          receiptInput?.addEventListener('change', () => {
            if (receiptInput.files?.[0]) {
              receiptFile = receiptInput.files[0]
              receiptLabel.textContent = receiptFile.name
              receiptLabel.style.color = 'var(--c-green)'
              receiptBtn.disabled = false
            }
          })

          receiptBtn?.addEventListener('click', async () => {
            if (!receiptFile) return
            receiptBtn.disabled = true
            receiptBtn.textContent = 'Uploading...'
            receiptStatus.textContent = ''
            try {
              await submitWireReceipt(cred, receiptFile)
              receiptStatus.innerHTML = '<span style="color:var(--c-green);font-weight:600">Receipt uploaded successfully! We will verify your payment shortly.</span>'
              receiptBtn.textContent = 'Uploaded'
              const dropEl = document.getElementById('receipt-drop')
              if (dropEl) dropEl.style.borderColor = 'var(--c-green)'
            } catch (e: any) {
              receiptStatus.innerHTML = `<span style="color:var(--c-red)">Upload failed: ${esc(e?.message || '')}</span>`
              receiptBtn.disabled = false
              receiptBtn.textContent = 'Upload Receipt'
            }
          })
        }
      } else {
        setStatusMsg('Agreement signed and submitted!')
        setStatusType('success')
      }
    } catch (e: any) {
      setSigning(false)
      setStatusMsg(isClientFacingError(e) ? e.message : 'Error: ' + e.message + '. Please try again.')
      setStatusType('error')
      const actionBar = document.getElementById('tax-action-bar')
      if (actionBar) actionBar.style.display = 'block'
    }
  }

  return (
    <>
      <div id="tax-success-state" style={{ display: 'none' }} />

      <div id="tax-contract-body" ref={bodyRef}>
        {/* HEADER */}
        <div className="contract-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo.jpg" alt="Tony Durante LLC" />
          <h1>{multi ? 'Service Agreements' : ct.title}</h1>
        </div>

        {multi ? (
          <>
            <div className="contract-section" data-agreements-intro>
              <p>
                This document contains <strong>{agreements.length} agreements</strong>, for the following services in your offer:
              </p>
              <ol>
                {agreements.map(({ type, line }, i) => <li key={i}>{wording(type).title} &mdash; {line.name}</li>)}
              </ol>
              <p>You sign once, at the end of the document. Your signature accepts every agreement listed above.</p>
            </div>

            {/* ONE AGREEMENT PER SERVICE — same wording a single-service offer shows; one signature covers all */}
            {agreements.map(({ type, line }, i) => {
              const xct = wording(type)
              const ph = phrasesFor(xct)
              return (
                <div key={i} data-agreement={type} style={i > 0 ? { pageBreakBefore: 'always', marginTop: 48 } : undefined}>
                  <div className="contract-part-divider"><h2>{xct.title}</h2></div>
                  <AgreementBody ct={xct} clientName={name} serviceName={line.name || xct.shortTitle} serviceDesc={line.description || ''} fee={line.price || ''} includes={(line.includes || []) as string[]} scopeClosing={scopeClosingFor(type, xct, line)} workPhrase={ph.workPhrase} liabilityPhrase={ph.liabilityPhrase} />
                </div>
              )
            })}
          </>
        ) : (
          /* AGREEMENT — parties, summary and sections 1-8 */
          <AgreementBody ct={ct} clientName={name} serviceName={serviceName} serviceDesc={serviceDesc} fee={fee} includes={includes as string[]} scopeClosing={scopeClosing} workPhrase={workPhrase} liabilityPhrase={liabilityPhrase} />
        )}

        {/* CLIENT INFORMATION */}
        <table className="contract-client-form" id="tax-client-form">
          <caption style={{ fontFamily: "'Inter',sans-serif", fontWeight: 700, fontSize: '11pt', textAlign: 'left', paddingBottom: 6, color: 'var(--c-primary)' }}>Client Information</caption>
          <tbody>
            <tr>
              <th>Full Name</th>
              <td><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your full legal name" /></td>
            </tr>
            <tr>
              <th>Email Address</th>
              <td><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" /></td>
            </tr>
          </tbody>
        </table>

        {/* SIGNATURE */}
        <div className="contract-sig-section">
          <h3 style={{ textAlign: 'center' }}>Acceptance &amp; Signature</h3>
          {!multi ? (
            <p className="contract-text-center contract-text-muted" style={{ marginBottom: 16, fontSize: '9.5pt' }}>
              {ct.signatureText}
            </p>
          ) : (
            <div data-combined-acceptance>
              <p className="contract-text-center contract-text-muted" style={{ marginBottom: 8, fontSize: '9.5pt' }}>
                <strong>By signing once below, I accept each of the {agreements.length} agreements in this document:</strong>
              </p>
              {Array.from(new Set(agreements.map(({ type }) => type))).map((type) => (
                <p key={type} className="contract-text-center contract-text-muted" style={{ marginBottom: 10, fontSize: '9.5pt' }}>
                  <strong>{wording(type).title}.</strong> {wording(type).signatureText}
                </p>
              ))}
            </div>
          )}
          <div className="contract-sig-grid">
            <div className="contract-sig-block">
              <div className="contract-sig-label">Service Provider</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="contract-sig-static"><img src="/images/logo.jpg" alt="Tony Durante" style={{ maxHeight: 40, opacity: 0.8 }} /></div>
              <div className="contract-sig-field">Name: Antonio Noel Durante</div>
              <div className="contract-sig-field">Title: Executive Director</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
            <div className="contract-sig-block">
              <div className="contract-sig-label">Client</div>
              <div className="contract-sig-canvas-wrap">
                <canvas ref={sigRef} style={{ width: '100%', height: 120, display: 'block', borderRadius: 6 }} />
                <button className="contract-clear-btn" onClick={clearSig}>Clear</button>
              </div>
              <div className="contract-sig-field">Name: {name}</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div className="contract-text-center" style={{ marginTop: 36, paddingTop: 20, borderTop: '1px solid var(--c-border)' }}>
          <p className="contract-text-muted contract-text-small">Tony Durante LLC &bull; 10225 Ulmerton Road, Suite 3D &bull; Largo, FL 33771</p>
          <p className="contract-text-muted contract-text-small">support@tonydurante.us &bull; www.tonydurante.us</p>
          {contractVersionLabel((offer as { contract_version?: string | null }).contract_version) && (
            <p className="contract-text-muted contract-text-small">{contractVersionLabel((offer as { contract_version?: string | null }).contract_version)}</p>
          )}
        </div>
      </div>

      {/* ACTION BAR */}
      <div className="contract-action-bar" id="tax-action-bar">
        <button className="contract-btn contract-btn-sign" onClick={signAgreement} disabled={!ready || signing}>
          {signing ? 'Generating PDF...' : multi ? 'Sign & Accept All Agreements' : 'Sign & Accept Agreement'}
        </button>
        <div className={`contract-status-msg ${statusType === 'error' ? 'contract-error-msg' : statusType === 'success' ? 'contract-success-msg' : ''}`}>
          {statusMsg}
        </div>
      </div>
    </>
  )
}
