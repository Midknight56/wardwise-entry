import { DOOR_RATE_CENTS, FLYER_RATE_CENTS } from './caps';
export interface Payee { label: string; role: 'doors' | 'flyers'; email: string; rateCents: number }
export function payees(env: { PAYOUT_EMAIL_CREW: string }): Record<string, Payee> {
  return {
    'crew-north': { label: 'North Side door crew (sandbox)', role: 'doors', email: env.PAYOUT_EMAIL_CREW, rateCents: DOOR_RATE_CENTS },
    'print-shop': { label: 'Ward print shop (sandbox)', role: 'flyers', email: env.PAYOUT_EMAIL_CREW, rateCents: FLYER_RATE_CENTS },
    'crew-unclaimed': { label: 'New crew, no PayPal account yet (sandbox)', role: 'doors', email: 'crew-unclaimed@example.com', rateCents: DOOR_RATE_CENTS },
  };
}
