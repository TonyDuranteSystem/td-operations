// Tax Form PDF generator — placeholder
// Full implementation will be added when the tax form PDF feature is complete

export async function generateTaxFormPDF(_params: {
  companyName: string
  ein: string
  state: string
  incorporationDate: string
  taxYear: string
  submittedAt: string
  submittedData: Record<string, unknown>
  uploadPaths: string[]
}): Promise<Uint8Array> {
  throw new Error("generateTaxFormPDF not yet implemented")
}
