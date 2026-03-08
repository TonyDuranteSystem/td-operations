/**
 * Offer & Contract types — used by public pages
 */

export interface OfferCriticita {
  title: string
  description: string
}

export interface OfferAzione {
  title: string
  text?: string
  description?: string
}

export interface OfferStrategia {
  step_number: number
  title: string
  description: string
}

export interface OfferServizio {
  name?: string
  nome?: string
  price?: string
  prezzo?: string
  price_label?: string
  description?: string
  descrizione?: string
  recommended?: boolean
  includes?: string[]
}

export interface RiepilogoCostiItem {
  name: string
  price: string
}

export interface RiepilogoCosti {
  label: string
  items?: RiepilogoCostiItem[]
  total_label?: string
  total?: string
  totale?: string
  rate?: string
  installments?: string
}

export interface CostoAnnuale {
  label: string
  price: string
}

export interface SviluppoFuturo {
  text: string
}

export interface ProssimoPasso {
  step_number: number
  title: string
  description: string
}

export interface PaymentLink {
  url: string
  label: string
  amount: string
}

export interface BankDetails {
  beneficiary?: string
  iban?: string
  bic?: string
  bank_name?: string
  amount?: string
  reference?: string
}

export interface Offer {
  id: string
  token: string
  client_name: string
  client_email?: string
  offer_date: string
  intro_en?: string
  intro_it?: string
  criticita?: OfferCriticita[]
  azioni_immediate?: OfferAzione[]
  strategia?: OfferStrategia[]
  servizi?: OfferServizio[]
  servizi_aggiuntivi?: OfferServizio[]
  riepilogo_costi?: RiepilogoCosti[]
  costi_annuali?: CostoAnnuale[]
  sviluppi_futuri?: SviluppoFuturo[]
  prossimi_passi?: ProssimoPasso[]
  status: 'draft' | 'sent' | 'viewed' | 'signed' | 'completed' | 'expired'
  expires_at?: string
  viewed_at?: string
  view_count: number
  created_at: string
  updated_at: string
  payment_links?: PaymentLink[]
  payment_type?: 'checkout' | 'bank_transfer' | 'none'
  bank_details?: BankDetails
  effective_date?: string
}
