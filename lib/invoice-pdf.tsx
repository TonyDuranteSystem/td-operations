/**
 * Branded PDF Invoice Generator — Tony Durante LLC
 *
 * Uses @react-pdf/renderer to generate professional invoices
 * with TD branding, US flag colors footer, and certifications.
 */

import React from 'react'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  renderToBuffer,
} from '@react-pdf/renderer'

// ─── Brand Colors ───────────────────────────────────────────
const COLORS = {
  // US Flag colors
  red: '#B31942',        // Old Glory Red
  blue: '#0A3161',       // Old Glory Blue
  white: '#FFFFFF',
  // Brand
  tdRed: '#B22234',      // TD logo red (close to flag red)
  darkGray: '#2D2D2D',
  mediumGray: '#555555',
  lightGray: '#E8E8E8',
  veryLightGray: '#F5F5F5',
}

// ─── Company Info ───────────────────────────────────────────
const COMPANY = {
  name: 'Tony Durante LLC',
  tagline: 'Your Way to Freedom',
  address: '10225 Ulmerton Rd Ste 3D',
  cityStateZip: 'Largo, FL 33771',
  phone: '+1 (727) 423-4285',
  email: 'support@tonydurante.us',
  website: 'tonydurante.us',
  certifications: [
    'IRS Certified Acceptance Agent',
    'Public Notary',
    'Professional Tax Preparer',
  ],
}

// ─── Styles ─────────────────────────────────────────────────
const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 10,
    paddingTop: 40,
    paddingBottom: 100, // room for footer
    paddingHorizontal: 50,
    color: COLORS.darkGray,
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 30,
    borderBottom: `3px solid ${COLORS.tdRed}`,
    paddingBottom: 20,
  },
  headerLeft: {
    flexDirection: 'column',
  },
  companyName: {
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.tdRed,
    letterSpacing: 1,
  },
  tagline: {
    fontSize: 11,
    color: COLORS.mediumGray,
    fontFamily: 'Helvetica-Oblique',
    marginTop: 2,
  },
  headerRight: {
    textAlign: 'right',
    fontSize: 9,
    color: COLORS.mediumGray,
    lineHeight: 1.6,
  },

  // ── Invoice Title ──
  invoiceTitle: {
    fontSize: 28,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.blue,
    letterSpacing: 3,
    marginBottom: 20,
    textAlign: 'center',
  },

  // ── Invoice Meta (number, date, due date) ──
  metaSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 25,
  },
  billTo: {
    flex: 1,
  },
  billToLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.blue,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 6,
  },
  billToName: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkGray,
    marginBottom: 3,
  },
  billToDetail: {
    fontSize: 10,
    color: COLORS.mediumGray,
    lineHeight: 1.5,
  },
  invoiceMeta: {
    width: 180,
    backgroundColor: COLORS.veryLightGray,
    padding: 12,
    borderRadius: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  metaLabel: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.mediumGray,
  },
  metaValue: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkGray,
  },

  // ── Line Items Table ──
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: COLORS.blue,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 3,
    marginBottom: 2,
  },
  tableHeaderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: COLORS.white,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderBottom: `1px solid ${COLORS.lightGray}`,
  },
  tableRowAlt: {
    backgroundColor: COLORS.veryLightGray,
  },
  colDescription: { flex: 3 },
  colQty: { width: 50, textAlign: 'center' },
  colRate: { width: 80, textAlign: 'right' },
  colAmount: { width: 80, textAlign: 'right' },

  // ── Totals ──
  totalsSection: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 15,
  },
  totalsBox: {
    width: 220,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  totalLabel: {
    fontSize: 10,
    color: COLORS.mediumGray,
  },
  totalValue: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkGray,
  },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: COLORS.blue,
    borderRadius: 3,
    marginTop: 5,
  },
  grandTotalLabel: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.white,
  },
  grandTotalValue: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.white,
  },

  // ── Notes / Terms ──
  notesSection: {
    marginTop: 30,
    padding: 15,
    backgroundColor: COLORS.veryLightGray,
    borderRadius: 4,
    borderLeft: `3px solid ${COLORS.blue}`,
  },
  notesTitle: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.blue,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 5,
  },
  notesText: {
    fontSize: 10,
    color: COLORS.mediumGray,
    lineHeight: 1.6,
  },

  // ── Footer (US Flag Colors) ──
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  footerStripe: {
    height: 4,
    flexDirection: 'row',
  },
  stripeRed: {
    flex: 1,
    backgroundColor: COLORS.red,
  },
  stripeWhite: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderTop: `1px solid ${COLORS.lightGray}`,
    borderBottom: `1px solid ${COLORS.lightGray}`,
  },
  stripeBlue: {
    flex: 1,
    backgroundColor: COLORS.blue,
  },
  footerContent: {
    backgroundColor: COLORS.veryLightGray,
    paddingVertical: 12,
    paddingHorizontal: 50,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerLeft: {
    fontSize: 8,
    color: COLORS.mediumGray,
    lineHeight: 1.6,
  },
  footerRight: {
    textAlign: 'right',
    fontSize: 8,
    color: COLORS.mediumGray,
    lineHeight: 1.6,
  },
  footerCerts: {
    fontSize: 7,
    color: COLORS.blue,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    paddingVertical: 6,
    paddingHorizontal: 50,
    letterSpacing: 1,
  },
  footerBottom: {
    height: 6,
    flexDirection: 'row',
  },
})

// ─── Helpers ────────────────────────────────────────────────
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// ─── Types ──────────────────────────────────────────────────
export interface InvoiceLineItem {
  description: string
  amount: number
  quantity: number
}

export interface InvoiceData {
  invoiceNumber: string
  date: string           // YYYY-MM-DD
  dueDate: string        // YYYY-MM-DD
  customerName: string
  customerEmail?: string
  customerAddress?: string
  lineItems: InvoiceLineItem[]
  notes?: string
  terms?: string         // e.g. "Net 30"
  memo?: string
}

// ─── Invoice Document Component ─────────────────────────────
function InvoiceDocument({ data }: { data: InvoiceData }) {
  const subtotal = data.lineItems.reduce(
    (sum, item) => sum + item.amount * item.quantity,
    0
  )
  const total = subtotal // No tax for now — can be added later

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.companyName}>TONY DURANTE</Text>
            <Text style={styles.tagline}>Your Way to Freedom</Text>
          </View>
          <View style={styles.headerRight}>
            <Text>{COMPANY.name}</Text>
            <Text>{COMPANY.address}</Text>
            <Text>{COMPANY.cityStateZip}</Text>
            <Text>{COMPANY.phone}</Text>
            <Text>{COMPANY.email}</Text>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: COLORS.blue }}>
              {COMPANY.website}
            </Text>
          </View>
        </View>

        {/* ── Invoice Title ── */}
        <Text style={styles.invoiceTitle}>INVOICE</Text>

        {/* ── Meta Section ── */}
        <View style={styles.metaSection}>
          {/* Bill To */}
          <View style={styles.billTo}>
            <Text style={styles.billToLabel}>Bill To</Text>
            <Text style={styles.billToName}>{data.customerName}</Text>
            {data.customerAddress && (
              <Text style={styles.billToDetail}>{data.customerAddress}</Text>
            )}
            {data.customerEmail && (
              <Text style={styles.billToDetail}>{data.customerEmail}</Text>
            )}
          </View>

          {/* Invoice Details */}
          <View style={styles.invoiceMeta}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Invoice #</Text>
              <Text style={styles.metaValue}>{data.invoiceNumber}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Date</Text>
              <Text style={styles.metaValue}>{formatDate(data.date)}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Due Date</Text>
              <Text style={styles.metaValue}>{formatDate(data.dueDate)}</Text>
            </View>
            {data.terms && (
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Terms</Text>
                <Text style={styles.metaValue}>{data.terms}</Text>
              </View>
            )}
          </View>
        </View>

        {/* ── Line Items Table ── */}
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colDescription]}>
            Description
          </Text>
          <Text style={[styles.tableHeaderText, styles.colQty]}>Qty</Text>
          <Text style={[styles.tableHeaderText, styles.colRate]}>Rate</Text>
          <Text style={[styles.tableHeaderText, styles.colAmount]}>Amount</Text>
        </View>

        {data.lineItems.map((item, index) => (
          <View
            key={index}
            style={[
              styles.tableRow,
              index % 2 === 1 ? styles.tableRowAlt : {},
            ]}
          >
            <Text style={styles.colDescription}>{item.description}</Text>
            <Text style={styles.colQty}>{item.quantity}</Text>
            <Text style={styles.colRate}>{formatCurrency(item.amount)}</Text>
            <Text style={[styles.colAmount, { fontFamily: 'Helvetica-Bold' }]}>
              {formatCurrency(item.amount * item.quantity)}
            </Text>
          </View>
        ))}

        {/* ── Totals ── */}
        <View style={styles.totalsSection}>
          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>
                {formatCurrency(subtotal)}
              </Text>
            </View>
            <View style={styles.grandTotalRow}>
              <Text style={styles.grandTotalLabel}>TOTAL DUE</Text>
              <Text style={styles.grandTotalValue}>
                {formatCurrency(total)}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Notes / Terms ── */}
        {(data.notes || data.memo) && (
          <View style={styles.notesSection}>
            <Text style={styles.notesTitle}>Notes</Text>
            <Text style={styles.notesText}>
              {data.notes || data.memo}
            </Text>
          </View>
        )}

        {/* ── Thank You ── */}
        <View style={{ marginTop: 25, textAlign: 'center' }}>
          <Text
            style={{
              fontSize: 11,
              fontFamily: 'Helvetica-Oblique',
              color: COLORS.mediumGray,
            }}
          >
            Thank you for choosing Tony Durante LLC!
          </Text>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          {/* US Flag stripe */}
          <View style={styles.footerStripe}>
            <View style={styles.stripeRed} />
            <View style={styles.stripeWhite} />
            <View style={styles.stripeBlue} />
          </View>

          {/* Certifications */}
          <Text style={styles.footerCerts}>
            {COMPANY.certifications.join('  •  ')}
          </Text>

          {/* Footer content */}
          <View style={styles.footerContent}>
            <View>
              <Text style={styles.footerLeft}>
                {COMPANY.name}
              </Text>
              <Text style={styles.footerLeft}>
                {COMPANY.address}, {COMPANY.cityStateZip}
              </Text>
            </View>
            <View>
              <Text style={styles.footerRight}>
                {COMPANY.phone} | {COMPANY.email}
              </Text>
              <Text
                style={[
                  styles.footerRight,
                  { fontFamily: 'Helvetica-Bold', color: COLORS.blue },
                ]}
              >
                {COMPANY.website}
              </Text>
            </View>
          </View>

          {/* Bottom flag stripe */}
          <View style={styles.footerBottom}>
            <View style={styles.stripeRed} />
            <View style={styles.stripeWhite} />
            <View style={styles.stripeBlue} />
          </View>
        </View>
      </Page>
    </Document>
  )
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Generate a branded PDF invoice as a Buffer
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Uint8Array> {
  const buffer = await renderToBuffer(
    <InvoiceDocument data={data} />
  )
  return new Uint8Array(buffer)
}
