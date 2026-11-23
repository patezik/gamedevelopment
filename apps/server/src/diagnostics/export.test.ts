import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GameEngine } from '@hs/core/game';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportError, exportRepro, parseExportArguments, USAGE } from './export.ts';
import { createHarness } from './harness.ts';
import { REPRO_FORMAT, type ReproBundle } from './repro.ts';

const run = promisify(execFile);
const CLI = new URL('./export-cli.ts', import.meta.url).pathname;
const TOKEN = 'T'.repeat(43);

const reply = (status: number, body: unknown, asText = false) =>
  new Response(asText ? String(body) : JSON.stringify(body), { status });
const bundle = { format: REPRO_FORMAT, version: 1, stateHash: 'abc' };
const fakeFetch = (response: Response | Error) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: typeof fetch = (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  return { fn, calls };
};
const base = { baseUrl: 'http://127.0.0.1:7420', sessionId: 'session-a', token: TOKEN };

describe('exportRepro', () => {
  it('asks the debug endpoint with the token in a header, never in the URL', async () => {
    const { fn, calls } = fakeFetch(reply(200, bundle));
    expect(await exportRepro({ ...base, fetch: fn })).toEqual(bundle);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7420/api/v1/sessions/session-a/debug/export');
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it.each<[string, Response | Error, RegExp]>([
    ['the flag off or an unknown session (404)', reply(404, {}), /HS_DEBUG_TRUTH=1/],
    ['a rejected token (401)', reply(401, {}), /rejected the desktop token/],
    ['a server error', reply(500, {}), /answered 500/],
    [
      'a server that cannot be reached',
      new Error('connect ECONNREFUSED'),
      /Could not reach http:\/\/127.0.0.1:7420: connect ECONNREFUSED/,
    ],
    ['an answer that is not JSON', reply(200, 'oops', true), /did not return JSON/],
    [
      'JSON that is not a repro bundle',
      reply(200, { hello: 'world' }),
      /did not return a repro bundle/,
    ],
    ['a null answer', reply(200, null), /did not return a repro bundle/],
  ])('explains %s', async (_name, response, message) => {
    const { fn } = fakeFetch(response);
    await expect(exportRepro({ ...base, fetch: fn })).rejects.toThrow(message);
    await expect(exportRepro({ ...base, fetch: fn })).rejects.toBeInstanceOf(ExportError);
  });

  it.each(['', '../x', 'a/b', 'a b', 'a?x=1', 'a'.repeat(65)])(
    'refuses the session id %j before asking',
    async (sessionId) => {
      const { fn, calls } = fakeFetch(reply(200, bundle));
      await expect(exportRepro({ ...base, sessionId, fetch: fn })).rejects.toThrow(
        /valid session id/,
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses an empty token before asking', async () => {
    const { fn, calls } = fakeFetch(reply(200, bundle));
    await expect(exportRepro({ ...base, token: '', fetch: fn })).rejects.toThrow(
      /token is required/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('parseExportArguments', () => {
  const env = { HS_DESKTOP_TOKEN: TOKEN };

  it('takes the session id and the token from the environment, with sensible defaults', () => {
    expect(parseExportArguments(['session-a'], env)).toEqual({
      sessionId: 'session-a',
      baseUrl: 'http://127.0.0.1:7420',
      out: undefined,
      token: TOKEN,
    });
  });

  it('reads --url and --out in any order', () => {
    expect(
      parseExportArguments(['--out', 'r.json', 's', '--url', 'http://h:1'], env),
    ).toMatchObject({
      sessionId: 's',
      baseUrl: 'http://h:1',
      out: 'r.json',
    });
  });

  it.each<[string, string[], NodeJS.ProcessEnv, RegExp]>([
    ['no session id', [], env, /session id is required/],
    ['no token in the environment', ['s'], {}, /HS_DESKTOP_TOKEN/],
    ['an empty token', ['s'], { HS_DESKTOP_TOKEN: '' }, /HS_DESKTOP_TOKEN/],
    ['the token on the command line', ['s', '--token', TOKEN], env, /not on the command line/],
    [
      'the token on the command line with =',
      ['s', `--token=${TOKEN}`],
      env,
      /not on the command line/,
    ],
    ['an unknown option', ['s', '--verbose'], env, /Unknown option --verbose/],
    ['a second positional argument', ['a', 'b'], env, /Unexpected argument b/],
    ['--url without a value', ['s', '--url'], env, /--url needs a value/],
    ['--out without a value', ['s', '--out'], env, /--out needs a value/],
  ])('rejects %s', (_name, argv, environment, message) => {
    expect(() => parseExportArguments(argv, environment)).toThrow(message);
  });

  it('never repeats a token that was given on the command line', () => {
    try {
      parseExportArguments(['s', '--token', 'SUPERSECRETVALUE'], {});
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('SUPERSECRETVALUE');
    }
  });
});

describe('the export-repro command against a running server', () => {
  const open: Awaited<ReturnType<typeof createHarness>>[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map(({ app }) => app.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function serve(debugTruth: boolean) {
    const h = await createHarness({ debugTruth });
    open.push(h);
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not start');
    return { h, url: `http://127.0.0.1:${address.port}` };
  }
  const cli = (args: string[], env: Record<string, string>) =>
    run(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      }),
    );

  it('writes a private file that restores the live session', async () => {
    const { h, url } = await serve(true);
    await h.session.dispatch('desktop', { type: 'wait', minutes: 30 });
    const dir = mkdtempSync(join(tmpdir(), 'repro-'));
    dirs.push(dir);
    const out = join(dir, 'repro.json');

    const result = await cli(['session-a', '--url', url, '--out', out], {
      HS_DESKTOP_TOKEN: h.desktopToken,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Wrote');
    expect(result.stderr).not.toContain(h.desktopToken);
    expect(statSync(out).mode & 0o777).toBe(0o600); // it holds the solution

    const saved = JSON.parse(readFileSync(out, 'utf8')) as ReproBundle;
    expect(saved).toMatchObject({
      format: REPRO_FORMAT,
      scenarioId: 'tiny-manor',
      seed: 'harness-seed',
    });
    expect(saved.snapshot.minute).toBe(30);
    const restored = GameEngine.restore(saved.snapshot, h.investigation, h.ports);
    expect(restored.stateHash()).toBe(h.engine.stateHash());
  });

  it('prints the bundle to stdout when no file is asked for', async () => {
    const { h, url } = await serve(true);
    const result = await cli(['session-a', '--url', url], { HS_DESKTOP_TOKEN: h.desktopToken });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as ReproBundle).stateHash).toBe(h.engine.stateHash());
  });

  it.each<[string, boolean, (h: Awaited<ReturnType<typeof createHarness>>) => string, RegExp]>([
    ['the server runs without the debug flag', false, (h) => h.desktopToken, /HS_DEBUG_TRUTH=1/],
    ["the token is the phone's", true, (h) => h.phoneToken, /rejected the desktop token/],
  ])('exits with 2 and explains when %s', async (_name, flag, token, message) => {
    const { h, url } = await serve(flag);
    const result = await cli(['session-a', '--url', url], { HS_DESKTOP_TOKEN: token(h) });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain(USAGE);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(token(h));
  });

  it('exits with 2 and the usage text when called without a token', async () => {
    const result = await cli(['session-a'], { HS_DESKTOP_TOKEN: '' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('HS_DESKTOP_TOKEN');
    expect(result.stderr).toContain(USAGE);
  });

  it('refuses a token on the command line without printing it', async () => {
    const result = await cli(['session-a', '--token', 'SUPERSECRETVALUE'], {
      HS_DESKTOP_TOKEN: '',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not on the command line');
    expect(result.stderr).not.toContain('SUPERSECRETVALUE');
  });
});
