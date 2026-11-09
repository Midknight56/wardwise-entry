import { logFailure } from '../logging';
import { ACCOUNT_CAP, APP, APP_CAP, RESERVE } from '../caps';
export { ACCOUNT_CAP, APP, APP_CAP, RESERVE } from '../caps';
export class NeuronLedger {
  constructor(private db: D1Database, private now = Date.now) {}
  async reserve(): Promise<number | null> {
    try {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const row = await this.db.prepare(`INSERT INTO ai_calls (app,day,neurons) SELECT ?,?,?
        WHERE (SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE app=? AND day=?) + ? <= ?
        AND (SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE day=?) + ? <= ? RETURNING id`)
        .bind(APP, day, RESERVE, APP, day, RESERVE, APP_CAP, day, RESERVE, ACCOUNT_CAP).first<{ id: number }>();
      return row?.id ?? null;
    } catch (e) { logFailure('ai-ledger', '/api/ask/reserve', e); return null; }
  }
  async settle(id: number, actual?: number): Promise<void> {
    // Never release a reservation without trustworthy real usage. An error keeps the full hold.
    if (actual === undefined || !Number.isFinite(actual) || actual < 0) return;
    try { await this.db.prepare('UPDATE ai_calls SET neurons=? WHERE id=? AND app=?').bind(actual, id, APP).run(); } catch (e) { logFailure('ai-ledger', '/api/ask/settle', e); }
  }
}
