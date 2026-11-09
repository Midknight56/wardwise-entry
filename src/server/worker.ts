import { logFailure } from './logging';
import cityJson from '../../public/data/chicago.json';
import type { CityData } from '../model/types';
import type { Env } from './env';
import { route } from './router';
import { PayPal } from './paypal/client';
import { ask, type RecordedAnswer } from './ai/ask';
import { NeuronLedger } from './ai/ledger';
import { ApiError } from './errors';
import type { CampaignEngine } from './campaign/engine';
export { CampaignDO } from './campaign/do';
export { GateDO } from './gate/do';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let recorded: RecordedAnswer[] | undefined;
    if (env.LIVE_AI !== '1' && new URL(request.url).pathname === '/api/ask') {
      try {
        const response = await env.ASSETS.fetch(new Request(new URL('/data/recorded-answers.json', request.url)));
        if (response.ok) { const data = await response.json() as RecordedAnswer[] | { answers: RecordedAnswer[] }; recorded = Array.isArray(data) ? data : data.answers; }
      } catch (e) { logFailure('ai-recorded', '/data/recorded-answers.json', e); }
    }
    const campaign = () => {
      const stub = env.CAMPAIGN.getByName('demo');
      // RPC transports Error.message, but not custom ApiError fields. Use a plain result envelope.
      return new Proxy({} as CampaignEngine, { get: (_, action: string) => async (...args: unknown[]) => {
        const result = await stub.dispatch(action, args);
        if (!result.ok) throw new ApiError(result.status, result.error, result.message);
        return result.value;
      } });
    };
    return route(request, { campaign, ask: input => ask(input, { wards: city.wards, gate: env.GATE.getByName('gate'), ledger: new NeuronLedger(env.LEDGER),
      ai: { run: (model, input) => env.AI.run(model as Parameters<Ai['run']>[0], input) }, live: env.LIVE_AI === '1', recorded,
      readyWorklogs: () => campaign().payrollPreview() }),
      paypal: new PayPal(env), webhookId: env.PAYPAL_WEBHOOK_ID, assets: req => env.ASSETS.fetch(req), dev: env.DEV_ROUTES === '1', build: env.BUILD_TAG ?? 'unknown' });
  },
} satisfies ExportedHandler<Env>;
const city = cityJson as unknown as CityData;
