import { buildApp } from './app.ts';
import { readConfig } from './config/index.ts';
import { watchParentProcess } from './parent-watch.ts';
import { createSessionServices } from './routes/generation.ts';
import { isSea } from 'node:sea';
import { dirname, join } from 'node:path';

// SEA bundles use CommonJS and carry content next to the executable.
async function main(): Promise<void> {
  try {
    const config = readConfig(process.env);
    const services = createSessionServices(config, isSea()
      ? { scenariosDir: join(dirname(process.execPath), 'content', 'scenarios') }
      : {});
    const app = buildApp(config, services);
    await app.listen({ host: config.host, port: config.port });
    if (config.debugTruth) {
      app.log.warn('HS_DEBUG_TRUTH is on: the debug endpoints can reveal the solution of any session');
    }
    watchParentProcess(process.env.HS_PARENT_PID, () => {
      void app.close().finally(() => process.exit(0));
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
