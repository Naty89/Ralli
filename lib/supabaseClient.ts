import { createBrowserClient } from "@supabase/ssr";

// Browser client for client-side operations
// Using 'any' for database type to avoid strict typing issues
// In production, generate proper types with: npx supabase gen types typescript
export function createClient() {
  return createBrowserClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Export a singleton instance for convenience
export const supabase = createClient();
