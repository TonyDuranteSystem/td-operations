'use client'

export default function PaymentSuccessPage() {
  return (
    <>
      <style>{`
        .ps-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0A3161 0%, #1a4a7a 100%); font-family: Georgia, 'Times New Roman', serif; padding: 24px; }
        .ps-card { background: #fff; border-radius: 16px; padding: 48px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
        .ps-icon { font-size: 64px; margin-bottom: 16px; }
        .ps-title { font-size: 28px; font-weight: 700; color: #0A3161; margin-bottom: 12px; }
        .ps-message { font-size: 16px; color: #555; line-height: 1.6; margin-bottom: 32px; }
        .ps-btn { display: inline-block; background: linear-gradient(135deg, #B31942 0%, #8B1233 100%); color: #fff; padding: 14px 40px; border-radius: 8px; font-weight: 700; font-size: 16px; text-decoration: none; transition: transform .2s, box-shadow .2s; }
        .ps-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(179,25,66,.3); }
        .ps-footer { margin-top: 24px; font-size: 13px; color: #999; }
      `}</style>
      <div className="ps-container">
        <div className="ps-card">
          <div className="ps-icon">&#10004;&#65039;</div>
          <h1 className="ps-title">Payment Received</h1>
          <p className="ps-message">
            Thank you! Your payment has been confirmed. We will begin working on your service right away.
            You can track progress in your client portal.
          </p>
          <a href="https://portal.tonydurante.us/portal" className="ps-btn">Go to Portal</a>
          <div className="ps-footer">Tony Durante LLC — Your Way to Freedom</div>
        </div>
      </div>
    </>
  )
}
