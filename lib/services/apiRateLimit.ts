import "server-only";
import nodeCrypto from "crypto";
import { createAdminClient } from "@/lib/supabaseServer";

// Hash client IPs before storing them. Prefer proxy-provided address headers
// and keep raw IPs out of the rate-limit table.
function getClientAddress(request: Request): string {
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function checkPublicApiRateLimit(
  request: Request,
  routeKey: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; error: Error | null }> {
  const clientHash = nodeCrypto
    .createHash("sha256")
    .update(getClientAddress(request))
    .digest("hex");

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("consume_api_rate_limit", {
    p_route_key: routeKey,
    p_client_hash: clientHash,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) return { allowed: false, error: new Error(error.message) };
  return { allowed: data === true, error: null };
}
