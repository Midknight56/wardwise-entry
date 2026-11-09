// Read-only integration against a checkout where the model and data jobs have landed.
// node tests/helpers/check-integration.mjs A:/Projects/wardwise
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const target = resolve(process.argv[2] ?? '..');
const root = process.cwd();
const cityPath = resolve(target, 'public/data/chicago.json');
await readFile(cityPath); // Do not silently substitute fixture data in an integration check.
const plugin = {
  name: 'completed-model-and-data',
  setup(build) {
    build.onResolve({ filter: /(?:^|\/)model\/(allocate|explain|forceMove|types)(?:\.ts)?$/ }, args => {
      const file = args.path.match(/([^/]+?)(?:\.ts)?$/)[1];
      return { path: resolve(target, `src/model/${file}.ts`) };
    });
    build.onResolve({ filter: /public\/data\/chicago\.json$/ }, () => ({ path: cityPath }));
  },
};
const bundled = await build({ absWorkingDir: root, entryPoints: ['src/server/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], plugins: [plugin] });
const integration = await build({ absWorkingDir: root, entryPoints: ['tests/helpers/integration.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', plugins: [plugin] });
await import('data:text/javascript;base64,' + Buffer.from(integration.outputFiles[0].contents).toString('base64'));
console.log(`Worker bundle and real model/data integration passed (${bundled.outputFiles[0].contents.length} bytes).`);
