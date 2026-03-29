import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/**
 * Lazy-initialized Supabase client.
 * Safe to import at module scope — won't crash during SSR/build
 * when env vars aren't available.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_client) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
      if (!url || !key) {
        // During build/SSR without env vars — return a no-op
        if (typeof window === "undefined") {
          return (..._args: unknown[]) => Promise.resolve({ data: null, error: null });
        }
        throw new Error("Supabase URL and key are required");
      }
      _client = createClient(url, key);
    }
    return (_client as unknown as Record<string, unknown>)[prop as string];
  },
});
