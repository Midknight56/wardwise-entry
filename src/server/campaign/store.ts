export type Table = 'records' | 'ops' | 'events' | 'donations' | 'refunds' | 'worklogs' | 'payrolls';
export interface Store {
  get<T>(table: Table, id: string): T | undefined;
  put<T>(table: Table, id: string, value: T): void;
  list<T>(table: Table): T[];
}
export class SqlStore implements Store {
  constructor(private sql: SqlStorage) {
    for (const table of ['records', 'ops', 'events', 'donations', 'refunds', 'worklogs', 'payrolls'])
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.sql.exec<{ json: string }>(`SELECT json FROM ${table} WHERE id=?`, id).toArray()[0];
    return row ? JSON.parse(row.json) as T : undefined;
  }
  put<T>(table: Table, id: string, value: T): void {
    this.sql.exec(`INSERT INTO ${table} (id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`, id, JSON.stringify(value));
  }
  list<T>(table: Table): T[] { return this.sql.exec<{ json: string }>(`SELECT json FROM ${table}`).toArray().map(r => JSON.parse(r.json) as T); }
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
