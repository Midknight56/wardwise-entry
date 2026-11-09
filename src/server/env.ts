import type { CampaignDO } from './campaign/do';
import type { GateDO } from './gate/do';
// Kept within J2 scope; binding names mirror wrangler.jsonc. Generate Env on final integration.
export interface Env {
  CAMPAIGN: DurableObjectNamespace<CampaignDO>; GATE: DurableObjectNamespace<GateDO>;
  AI: Ai; LEDGER: D1Database; ASSETS: Fetcher;
  PAYPAL_CLIENT_ID: string; PAYPAL_CLIENT_SECRET: string; PAYPAL_WEBHOOK_ID: string;
  PAYOUT_EMAIL_CREW: string; PAYPAL_BASE?: string; LIVE_AI?: string; DEV_ROUTES?: string; BUILD_TAG?: string;
}
