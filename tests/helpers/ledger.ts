import { DatabaseSync } from 'node:sqlite';
// Real SQLite executes the same single SQL statement as remote D1; no external service.
export function memoryLedger() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, day TEXT NOT NULL, neurons REAL NOT NULL)');
  const database = { prepare(query: string) {
    return { bind(...values: (number | string | null)[]) {
      const prepared = sql.prepare(query);
      return { async first<T>(): Promise<T | null> { return prepared.get(...values) as T ?? null; }, async run() { return prepared.run(...values); } };
    } };
  } };
  return { sql, database: database as unknown as D1Database };
}
