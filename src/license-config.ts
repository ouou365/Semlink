// ========================================
// Semlink - License configuration
// ========================================
// Deployment-dependent constants for the freemium licensing system.
// The license backend (a Cloudflare Worker at license.getsemlink.com)
// creates checkout sessions with whichever payment provider / Merchant
// of Record is live server-side; the plugin never holds payment links
// and never talks to a payment provider directly.

/** License backend endpoints, tried in order. The primary is the Cloudflare
 *  Worker (paying users are mostly overseas — see docs/license-backend-design.md
 *  §10); optionally append the Tencent SCF URL as a mainland-friendly
 *  fallback. Only network errors fail over — semantic 4xx responses come
 *  from whichever endpoint answered. Empty array = licensing not yet live:
 *  all license UI shows the "service not configured" state.
 *  Example: ["https://license.getsemlink.com", "https://xxx.gz.apigw.tencentcs.com"] */
export const LICENSE_API_BASES: string[] = ["https://license.getsemlink.com"];

/** Ed25519 public key (SPKI DER, base64) used to verify activation tokens
 *  signed by the license cloud function. Replacing it invalidates all
 *  previously issued tokens — rotate only with a coordinated backend change. */
export const LICENSE_PUBLIC_KEY_B64 =
	"MCowBQYDK2VwAyEAZYPE4b53YL+Y3z4Gah8qVMV8a5DukCMwROJXt/FP704=";

/** Free tier: number of most-recent chat sessions kept fully accessible.
 *  Older sessions stay on disk but land in the locked archive section. */
export const FREE_HISTORY_LIMIT = 5;

/** How long an activation token stays valid without an online re-validation
 *  (the offline grace window). */
export const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

/** Re-validate online at most once per day while the token is still valid. */
export const REVALIDATE_INTERVAL_MS = 24 * 3600 * 1000;
