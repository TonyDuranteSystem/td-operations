/**
 * The fixed sentences of the EIN closure letter — ONE place, used by the PDF builder (lib/closure/ein-closure-letter.ts) and by the preview the client
 * sees next to the signature box in the closure wizard (components/portal/wizard/wizard-signature-field.tsx), so what the client signs for and what is
 * printed can never drift apart. They are word for word what every closure letter in production already said (Dynamiq 2023, Terra Prime, MaoBao, Italyflow).
 * No imports: this file is bundled into the browser.
 */
export const EIN_LETTER_TO = 'Internal Revenue Service'
export const EIN_LETTER_REQUEST = 'Close Business Account/Cancel EIN'
export const EIN_LETTER_BODY_CLOSE = 'Please close the business account associated with the EIN listed above. I am no longer using this account.'
export const EIN_LETTER_BODY_QUESTIONS = 'Please let me know if you have any questions or need anything else.'
export const EIN_LETTER_BODY_COPY = 'I have included a copy of the original EIN Assignment /Confirmation Letter.'
export const EIN_LETTER_REPLY_INTRO = 'Please mail a confirmation letter to the address listed below.'

/** The most address lines the letter has room for, and the longest one (a longer line wraps onto the next row of the same address). The box in the workspace and the letter maker use the same numbers. */
export const MAX_ADDRESS_LINES = 6
export const MAX_ADDRESS_LINE_CHARS = 120
export const MAX_COMPANY_NAME_CHARS = 150
