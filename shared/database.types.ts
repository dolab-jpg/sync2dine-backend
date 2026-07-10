export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string
          legacy_id: string | null
          name: string
          contact_name: string
          contact_email: string
          contact_phone: string
          address: string | null
          status: 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled'
          plan: 'starter' | 'pro' | 'enterprise'
          openai_api_key_encrypted: string
          monthly_token_cap: number
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string | null
          current_period_end: string | null
          trial_ends_at: string | null
          whatsapp_phone_number_id: string | null
          phone_did: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['organizations']['Row']> & { name: string }
        Update: Partial<Database['public']['Tables']['organizations']['Row']>
      }
      profiles: {
        Row: {
          id: string
          legacy_id: string | null
          org_id: string | null
          name: string
          email: string
          role: 'platform_owner' | 'super_admin' | 'manager' | 'staff' | 'builder' | 'recruitment' | 'customer'
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['profiles']['Row']> & { id: string; email: string }
        Update: Partial<Database['public']['Tables']['profiles']['Row']>
      }
      customers: {
        Row: { id: string; org_id: string; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['customers']['Row']>
      }
      contacts: {
        Row: { id: string; org_id: string; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['contacts']['Row']>
      }
      builders: {
        Row: { id: string; org_id: string; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['builders']['Row']>
      }
      quotes: {
        Row: { id: string; org_id: string; customer_id: string | null; status: string | null; total: number | null; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['quotes']['Row']>
      }
      products: {
        Row: { id: string; org_id: string; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['products']['Row']>
      }
      pricing_rules: {
        Row: { id: string; org_id: string; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['pricing_rules']['Row']>
      }
      projects: {
        Row: { id: string; org_id: string; customer_id: string | null; quote_id: string | null; status: string | null; portal_token: string | null; data: Json; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['projects']['Row']>
      }
      project_files: {
        Row: { id: string; org_id: string; project_id: string; storage_path: string; filename: string; mime_type: string; source: string | null; uploaded_by: string | null; caption: string | null; taken_at: string | null; message_id: string | null; task_id: string | null; bucket: string; created_at: string }
        Insert: Partial<Database['public']['Tables']['project_files']['Row']> & { id: string; org_id: string; project_id: string; storage_path: string; filename: string }
        Update: Partial<Database['public']['Tables']['project_files']['Row']>
      }
      contracts: {
        Row: { id: string; org_id: string; project_id: string | null; signing_token: string | null; status: string; data: Json; signed_at: string | null; created_at: string; updated_at: string }
        Insert: { id: string; org_id: string; data?: Json }
        Update: Partial<Database['public']['Tables']['contracts']['Row']>
      }
      usage_events: {
        Row: { id: string; org_id: string; user_id: string | null; model: string | null; prompt_tokens: number; completion_tokens: number; total_tokens: number; route: string | null; created_at: string }
        Insert: Partial<Database['public']['Tables']['usage_events']['Row']> & { org_id: string }
        Update: Partial<Database['public']['Tables']['usage_events']['Row']>
      }
    }
    Views: Record<string, never>
    Functions: {
      get_project_by_portal_token: { Args: { token: string }; Returns: Json }
      get_contract_by_token: { Args: { token: string }; Returns: Json }
      user_org_id: { Args: Record<string, never>; Returns: string }
      is_platform_owner: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: {
      org_status: 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled'
      org_plan: 'starter' | 'pro' | 'enterprise'
      user_role: 'platform_owner' | 'super_admin' | 'manager' | 'staff' | 'builder' | 'recruitment' | 'customer'
    }
  }
}
