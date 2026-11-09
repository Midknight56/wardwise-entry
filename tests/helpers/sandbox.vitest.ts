// Isolated cache for worktrees whose node_modules is a read-only shared junction.
// npm test -- --config tests/helpers/sandbox.vitest.ts --configLoader runner
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
// This changes only the test process, keeping Vitest's local API token out of shared folders.
process.env[process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_DATA_HOME'] = resolve('tests/helpers/.runtime');
export default defineConfig({ cacheDir: 'tests/helpers/.runtime/vite', test: { include: ['tests/server*.test.ts'], environment: 'node', maxWorkers: 1, cache: false } });
