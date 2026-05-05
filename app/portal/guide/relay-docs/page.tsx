'use client'

import { ArrowLeft, FileText, CheckCircle, ChevronRight, Info, MessageCircle, FolderOpen } from 'lucide-react'
import Link from 'next/link'

export default function RelayDocsGuidePage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-8">

      {/* Back link */}
      <Link
        href="/portal/guide"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Guide
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
          <FileText className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
            Relay — International Payments Onboarding: Document Upload Guide
          </h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            What to upload to unlock international wire transfers on your Relay account.
          </p>
        </div>
      </div>

      {/* What you need */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <p className="text-sm font-semibold text-amber-800 mb-3">What you need before you start</p>
        <ul className="space-y-2">
          {[
            'Access to your Relay business account',
            'Your signed lease agreement with Tony Durante LLC',
            'Recent invoices issued by your LLC (last 60 days)',
            'Personal bank statements (last 60 days)',
            'Your Articles of Organization — available in your portal',
            'Your EIN Confirmation Letter from the IRS — available in your portal',
            'A personal proof of address dated within the last 60–90 days',
          ].map((item, i) => (
            <li key={i} className="flex items-center gap-2.5 text-sm text-amber-700">
              <CheckCircle className="h-4 w-4 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Steps */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold">Documents to upload</h2>
        {STEPS.map((step, i) => (
          <div key={i} className="bg-white rounded-xl border p-5">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-zinc-900 mb-1">{step.title}</p>
                <p className="text-sm text-zinc-500 leading-relaxed">{step.desc}</p>
                {step.items && (
                  <ul className="mt-3 space-y-1.5">
                    {step.items.map((item, j) => (
                      <li key={j} className="flex items-center gap-2 text-sm text-zinc-600">
                        <ChevronRight className="h-4 w-4 text-blue-400 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
                {step.portalNote && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                    {step.portalNote}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tips */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-800 mb-2">Good to know</p>
            <ul className="space-y-1.5">
              {[
                'For Proof of Operations, the more documents you submit the better — Relay explicitly recommends combining multiple files into one PDF.',
                'Paid invoices are ideal but unpaid invoices are also accepted for the Invoice requirement.',
                'Documents available in your portal (Articles of Organization, EIN Letter) are already in the correct format.',
                'Once submitted, Relay\'s review typically takes a few business days.',
              ].map((tip, i) => (
                <li key={i} className="text-sm text-blue-700 leading-relaxed">{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Help */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white text-center">
        <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-80" />
        <p className="text-sm font-semibold mb-1">Need Help?</p>
        <p className="text-xs opacity-80 mb-4">If you have questions about which documents to upload, our team is here to help.</p>
        <Link
          href="/portal/chat"
          className="inline-flex items-center gap-2 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 transition-colors"
        >
          <MessageCircle className="h-4 w-4" />
          Chat With Us
        </Link>
      </div>

    </div>
  )
}

const STEPS = [
  {
    title: 'Proof of Address (Business)',
    desc: 'Upload the signed lease agreement with Tony Durante LLC for your Florida address. This is your official US business address on file with Relay.',
  },
  {
    title: 'Invoice',
    desc: 'Upload an invoice issued by your LLC in the last 60 days. The invoice must be addressed to a US-based recipient — this is how Relay confirms your LLC is actively doing business in the United States. The recipient can be a US individual, a US company, or another US LLC. A paid invoice is preferred, but Relay also accepts unpaid ones.',
  },
  {
    title: 'Source of Wealth',
    desc: 'Upload your personal bank statements from the last 60 days.',
  },
  {
    title: 'Proof of Operations',
    desc: 'Upload multiple documents combined into a single PDF when possible. The more you submit, the stronger your application. Accepted documents:',
    items: [
      'Business invoices',
      'Lease agreement',
      'Client contracts or sales agreements',
      'Business plan',
      'Marketing materials',
    ],
  },
  {
    title: 'Certificate of Incorporation',
    desc: 'Upload your Articles of Organization — the document used to form your LLC.',
    portalNote: 'Available in your portal under Company Documents.',
  },
  {
    title: 'Employer Identification Number (EIN)',
    desc: 'Upload your EIN Confirmation Letter issued by the IRS.',
    portalNote: 'Available in your portal under Company Documents.',
  },
  {
    title: 'Proof of Address (Owner)',
    desc: 'Upload a personal document confirming your home address: a utility bill, bank statement, or any official document showing your name and address, dated within the last 60–90 days.',
  },
]
