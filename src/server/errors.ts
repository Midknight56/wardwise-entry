export class ApiError extends Error {
  constructor(public status: number, public error: string, message: string) { super(message); }
}
export function requireRule(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new ApiError(status, status === 429 ? 'daily_cap' : 'invalid_request', message);
}
export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  requireRule(value && typeof value === 'object' && !Array.isArray(value), 'Send a JSON object.');
  const body = value as Record<string, unknown>;
  requireRule(Object.keys(body).every(k => allowed.includes(k)), 'Unexpected field. Amounts and recipients are set by server rules.');
  return body;
}
export function errorResponse(e: unknown): Response {
  return Response.json({ error: e instanceof ApiError ? e.error : 'unavailable', message: e instanceof ApiError ? e.message : 'Service unavailable. Please try again.' }, { status: e instanceof ApiError ? e.status : 503 });
}
