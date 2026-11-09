// Log only error text, never objects, request headers or response payloads.
export function logFailure(tag: string, path: string, error: unknown, secrets: string[] = []): void {
  const clean = (value: string) => {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
    return value.replace(/[^\s@]+@[^\s@]+/g, '[email]')
      .replace(/(?:Bearer|Basic)\s+\S+/gi, '[authorization]')
      .replace(/(?:authorization|access_token|token|secret|password)\s*[=:]\s*[^,;\n]+/gi, '[redacted]')
      .replace(/[\r\n]/g, ' ').slice(0, 240);
  };
  console.error(tag, path, clean(error instanceof Error ? error.name : 'Error'), clean(error instanceof Error ? error.message : 'Unknown failure'));
}
