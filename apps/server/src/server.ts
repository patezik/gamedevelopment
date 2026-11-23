import { buildApp } from './app.ts';
import { readConfig } from './config/index.ts';

try {
  const config = readConfig(process.env);
  const app = buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  if (config.debugTruth) {
    app.log.warn(
      'HS_DEBUG_TRUTH is on: the debug endpoints can reveal the solution of any session',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
