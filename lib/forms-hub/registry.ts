/**
 * The standalone forms the CRM "Forms" page lists (dev job 11d484a4).
 * A standalone form is one that is NOT attached to a client account: staff make a one-time link for
 * it, send it to whoever must fill it, and read the submission here. Add a form = add one entry.
 */

export interface StandaloneForm {
  id: string
  name: string
  description: string
  /** Staff view of the form, exactly as the client sees it (nothing saved or sent). */
  viewHref: string
  /** The page that lists this form's links and submissions. */
  manageHref: string
  /** POST { label } here to mint a new one-time link; the response carries `link.url`. */
  createLinkApi: string
}

export const STANDALONE_FORMS: StandaloneForm[] = [
  {
    id: "bank-application",
    name: "Bank account application",
    description:
      "A one-time link for a client (ours or a partner's) to apply for a US business bank account: their details, a description of the business, and six documents. Everything is stored with us; if you add email addresses when you make the link, the finished form is also emailed to them.",
    viewHref: "/forms/bank-application/preview",
    manageHref: "/bofa-intake",
    createLinkApi: "/api/bofa-intake-admin",
  },
]
