/**
 * Re-export the Cloudflare Worker env from a dedicated module, for the same
 * bundling reason as `cloudflare-email-env.ts`.
 */

export { env } from "cloudflare:workers";
