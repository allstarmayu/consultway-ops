/**
 * Root page (/) — redirects based on auth state.
 *
 * Middleware doesn't currently guard "/" because we want the unauthenticated
 * homepage to be reachable (landing page, marketing, etc. land here later).
 * For now, the root just bounces visitors to the right place:
 *   - Logged in  → /dashboard
 *   - Logged out → /login
 *
 * @module app/page
 */
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await readSession();
  redirect(session ? "/dashboard" : "/login");
}
