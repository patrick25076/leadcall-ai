/**
 * Authenticated fetch wrapper for GRAI API calls.
 * Automatically includes the Supabase Bearer token.
 */

import { supabase } from "./supabase";

const API = process.env.NEXT_PUBLIC_API_URL || "";

export { API };

/**
 * Fetch wrapper that injects the Supabase auth token into every request.
 * Use exactly like `fetch()` but with a path relative to the API base.
 *
 * Example: apiFetch("/api/campaigns") or apiFetch("/api/analyze", { method: "POST", body: ... })
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  if (session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }
  return fetch(`${API}${path}`, { ...init, headers });
}
