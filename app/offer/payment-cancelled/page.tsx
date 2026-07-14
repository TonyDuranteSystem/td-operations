'use client'

import { Suspense } from 'react'
import { PORTAL_BASE_URL } from '@/lib/config'

/**
 * Where a cancelled payment sends the client.
 *
 * FIXED 2026-07-14 (dev_task ba7bfd8d): this used to link back to
 * `/offer/{token}` — the code-less proposal page, which has NO pay button at all
 * and re-prompts for the client's email. A client who cancelled on Stripe could
 * therefore never retry, from anywhere. Payment lives in the PORTAL and only in
 * the portal (see R092), so that is where "try again" must land.
 */
function PaymentCancelledContent() {
  return (
    <div className="pc-card">
      <div className="pc-icon">&#8617;&#65039;</div>
      <h1 className="pc-title">Payment Cancelled</h1>
      <p className="pc-message">
        No worries — your payment was not processed. You can return to your portal to try again,
        or contact us if you need assistance.
      </p>
      <div className="pc-buttons">
        <a href={`${PORTAL_BASE_URL}/portal/offer`} className="pc-btn">Return to Portal</a>
        <a href={`${PORTAL_BASE_URL}/portal/chat`} className="pc-btn pc-btn-secondary">Contact Us</a>
      </div>
      <div className="pc-footer">Tony Durante LLC — Your Way to Freedom</div>
    </div>
  )
}

export default function PaymentCancelledPage() {
  return (
    <>
      <style>{`
        .pc-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0A3161 0%, #1a4a7a 100%); font-family: Georgia, 'Times New Roman', serif; padding: 24px; }
        .pc-card { background: #fff; border-radius: 16px; padding: 48px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
        .pc-icon { font-size: 64px; margin-bottom: 16px; }
        .pc-title { font-size: 28px; font-weight: 700; color: #0A3161; margin-bottom: 12px; }
        .pc-message { font-size: 16px; color: #555; line-height: 1.6; margin-bottom: 32px; }
        .pc-btn { display: inline-block; background: linear-gradient(135deg, #B31942 0%, #8B1233 100%); color: #fff; padding: 14px 40px; border-radius: 8px; font-weight: 700; font-size: 16px; text-decoration: none; transition: transform .2s, box-shadow .2s; margin: 0 8px; }
        .pc-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(179,25,66,.3); }
        .pc-btn-secondary { background: linear-gradient(135deg, #1e3a5f 0%, #162d4a 100%); }
        .pc-footer { margin-top: 24px; font-size: 13px; color: #999; }
        .pc-buttons { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
      `}</style>
      <div className="pc-container">
        <Suspense fallback={<div className="pc-card"><p>Loading...</p></div>}>
          <PaymentCancelledContent />
        </Suspense>
      </div>
    </>
  )
}
