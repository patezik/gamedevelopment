import { buildApp } from './app.ts';
import { readConfig } from './config/index.ts';
import { watchParentProcess } from './parent-watch.ts';

// An async function instead of top-level await: the SEA bundle is CommonJS.
async function main(): Promise<void> {
  try {
    const config = readConfig(process.env);
    const app = buildApp(config);
    await app.listen({ host: config.host, port: config.port });
    if (config.debugTruth) {
      app.log.warn(
        'HS_DEBUG_TRUTH is on: the debug endpoints can reveal the solution of any session',
      );
    }
    // Set by the Godot ServerLauncher so the server does not outlive a crashed game.
    watchParentProcess(process.env.HS_PARENT_PID, () => {
      void app.close().finally(() => process.exit(0));
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
