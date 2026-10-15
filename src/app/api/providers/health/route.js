import { NextResponse } from "next/server";
import { getProviderHealthSummary } from "@/sse/services/backgroundProviderHealth.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/providers/health
 *
 * Read-only snapshot of the background provider health registry
 * (src/sse/services/backgroundProviderHealth.js). One entry per probed
 * provider: class, strikes, breaker deadline and the resolved verdict.
 *
 * Protected by the same /api/* auth middleware as the rest of the admin plane.
 */
export async function GET() {
  try {
    return NextResponse.json({ providers: getProviderHealthSummary() });
  } catch (error) {
    console.log("Error reading provider health:", error);
    return NextResponse.json({ error: "Failed to read provider health" }, { status: 500 });
  }
}
