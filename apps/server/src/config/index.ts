import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  HS_PORT: z
    .string()
    .regex(/^\d+$/, 'Expected an integer port from 1 to 65535')
    .transform(Number)
    .pipe(z.int().min(1).max(65535, 'Expected an integer port from 1 to 65535'))
    .default(7420),
  HS_HOST: z.string().trim().min(1).default('0.0.0.0'),
  HS_DATA_DIR: z
    .string()
    .trim()
    .min(1)
    .default(() => join(homedir(), '.hollow-signal')),
  HS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  HS_DEBUG_TRUTH: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
});

export function readConfig(env: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map(({ path, message }) => `${path.join('.')}: ${message}`)
      .join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }

  const data = result.data;
  return {
    port: data.HS_PORT,
    host: data.HS_HOST,
    dataDir: data.HS_DATA_DIR,
    logLevel: data.HS_LOG_LEVEL,
    debugTruth: data.HS_DEBUG_TRUTH,
  };
}

export type ServerConfig = ReturnType<typeof readConfig>;
