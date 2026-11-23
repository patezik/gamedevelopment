import { REPRO_FORMAT, type ReproBundle } from './repro.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportOptions {
  /** Where the server listens, e.g. `http://127.0.0.1:7420`. */
  readonly baseUrl: string;
  readonly sessionId: string;
  /** The session's desktop token (from `POST /sessions`). */
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/** Fetches a repro bundle from a running server started with `HS_DEBUG_TRUTH=1`. */
export async function exportRepro({
  baseUrl,
  sessionId,
  token,
  fetch: fetchFn = fetch,
}: ExportOptions): Promise<ReproBundle> {
  if (!SESSION_ID.test(sessionId)) throw new ExportError('That is not a valid session id');
  if (!token) throw new ExportError('A desktop token is required');

  const url = new URL(`/api/v1/sessions/${sessionId}/debug/export`, baseUrl);
  let reply: Response;
  try {
    reply = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new ExportError(
      `Could not reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (reply.status === 404) {
    throw new ExportError(
      'The server has no such debug endpoint or no such session. Start it with HS_DEBUG_TRUTH=1 and check the session id.',
    );
  }
  if (reply.status === 401) throw new ExportError('The server rejected the desktop token');
  if (!reply.ok) throw new ExportError(`The server answered ${reply.status}`);

  let bundle: Partial<ReproBundle>;
  try {
    bundle = (await reply.json()) as Partial<ReproBundle>;
  } catch {
    throw new ExportError('The server did not return JSON');
  }
  if (typeof bundle !== 'object' || bundle === null || bundle.format !== REPRO_FORMAT) {
    throw new ExportError('The server did not return a repro bundle');
  }
  return bundle as ReproBundle;
}

export interface ExportArguments {
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly out: string | undefined;
  readonly token: string;
}

export const USAGE = `Usage: HS_DESKTOP_TOKEN=<token> npm run export-repro -w @hs/server -- <sessionId> [--url http://127.0.0.1:7420] [--out repro.json]`;

/**
 * Reads the command line. The token is taken from the environment only: a command line is visible
 * to every process on the machine and ends up in shell history.
 */
export function parseExportArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ExportArguments {
  let sessionId: string | undefined;
  let baseUrl = 'http://127.0.0.1:7420';
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--url' || arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new ExportError(`${arg} needs a value`);
      if (arg === '--url') baseUrl = value;
      else out = value;
    } else if (arg === '--token' || arg.startsWith('--token=')) {
      throw new ExportError(
        'Pass the token in the HS_DESKTOP_TOKEN environment variable, not on the command line',
      );
    } else if (arg.startsWith('-')) {
      throw new ExportError(`Unknown option ${arg}`);
    } else if (sessionId === undefined) {
      sessionId = arg;
    } else {
      throw new ExportError(`Unexpected argument ${arg}`);
    }
  }
  if (sessionId === undefined) throw new ExportError('A session id is required');
  const token = env.HS_DESKTOP_TOKEN;
  if (!token)
    throw new ExportError('Set the HS_DESKTOP_TOKEN environment variable to the desktop token');
  return { sessionId, baseUrl, out, token };
}
