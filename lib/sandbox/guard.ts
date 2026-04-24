const PRODUCTION_SUPABASE_REF = "ydzipybqeebtpcvsbtvs"

/** Returns true if the running environment targets the production Supabase project. */
export function isProductionEnvironment(supabaseUrl?: string): boolean {
  const url = supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  return url.includes(PRODUCTION_SUPABASE_REF)
}
