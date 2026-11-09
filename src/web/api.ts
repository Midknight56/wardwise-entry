import type { CampaignEngine, MoneyRecord, PayrollRecord } from '../server/campaign/engine';
import type { Answer } from '../server/ai/ask';
export type { Answer, MoneyRecord, PayrollRecord };
export type MoneyState = Awaited<ReturnType<CampaignEngine['state']>>;
export type PayrollPreview = NonNullable<MoneyState['payrollPreview']>;
export const emptyState = (): MoneyState => ({ wards: {}, payees: [], payrolls: [], payrollPreview: { version: '', items: [], cents: 0, count: 0, readyCount: 0, excluded: 0, limit: null }, records: [], openItems: [], supporterTotal: 0, refundProposals: [] });

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch { throw new Error('Connection interrupted. Check the money log before trying again.'); }
  const data = await response.json().catch(() => null) as (T & { message?: string }) | null;
  if (!response.ok) throw new Error(data?.message || 'The service is unavailable. Please try again shortly.');
  if (!data) throw new Error('The service returned an unreadable answer.');
  return data;
}
