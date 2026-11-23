import { PlayerAction } from '@hs/protocol';
import type { FakeClient, Role } from './client.ts';
import { FakeDesktop, FakePhone } from './roles.ts';

export interface ReplContext {
  readonly role: Role;
  readonly baseUrl: string;
  /** The client the commands act on; `pair` replaces it for a phone. */
  client: FakeClient | undefined;
}

export const HELP = [
  'connect                 open the WebSocket and send hello',
  'status                  connection, seq, peers, protocol violations',
  'view                    the newest view (what the player may see)',
  'events                  events received so far',
  'log [n]                 the last n messages (type and seq only)',
  'action <json>           send a PlayerAction and wait for the result',
  'ping                    ping the server',
  'drop                    cut the connection; reconnect resumes it',
  'reconnect               connect again with resume',
  'code                    desktop: issue a pairing code',
  'unpair                  desktop: revoke the phone',
  'pair <code>             phone: pair with a code from the desktop',
  'scan <raw>              phone: send a scanned QR payload',
  'help | quit',
];

const json = (value: unknown) => JSON.stringify(value);

function need(context: ReplContext): FakeClient {
  if (!context.client) throw new Error('No client yet: pair first (phone) or restart with a token');
  return context.client;
}

/** Runs one REPL line and returns the lines to print; `undefined` means quit. Never prints secrets. */
export async function runCommand(
  context: ReplContext,
  line: string,
): Promise<string[] | undefined> {
  const [command = '', ...rest] = line.trim().split(/\s+/);
  const argument = line.trim().slice(command.length).trim();
  try {
    switch (command) {
      case '':
        return [];
      case 'help':
        return HELP;
      case 'quit':
      case 'exit':
        await context.client?.close();
        return undefined;
      case 'pair': {
        if (context.role !== 'phone') return ['pair is for the phone role'];
        const code = rest[0];
        if (!code) return ['usage: pair <code>'];
        context.client = await FakePhone.pair({ baseUrl: context.baseUrl, code });
        return ['paired; run connect'];
      }
      case 'connect': {
        const welcome = await need(context).connect();
        return [
          `connected as ${welcome.role}, session ${welcome.sessionId}, seq ${welcome.lastSeq}`,
        ];
      }
      case 'reconnect': {
        const welcome = await need(context).reconnect();
        return [`reconnected, seq ${welcome.lastSeq}`];
      }
      case 'drop':
        need(context).drop();
        return ['connection dropped'];
      case 'status': {
        const client = need(context);
        return [
          json({
            role: client.role,
            connected: client.connected,
            sessionId: client.sessionId ?? null,
            lastSeq: client.lastSeq,
            stateVersion: client.stateVersion,
            peers: client.peers ?? null,
            violations: client.violations,
          }),
        ];
      }
      case 'view': {
        const view = need(context).view;
        return [view ? json(view) : 'no view yet'];
      }
      case 'events':
        return need(context).events.map((event) => json(event));
      case 'log': {
        const count = Number(rest[0] ?? 10);
        return need(context)
          .messages.slice(-count)
          .map((message) => `${message.seq ?? '-'} ${message.type}`);
      }
      case 'ping':
        await need(context).ping();
        return ['pong'];
      case 'action': {
        const action = PlayerAction.parse(JSON.parse(argument));
        return [json(await need(context).sendAction(action))];
      }
      case 'code': {
        const client = need(context);
        if (!(client instanceof FakeDesktop)) return ['code is for the desktop role'];
        const { code, expiresAt } = await client.createPairingCode();
        return [`pairing code ${code}, expires at ${new Date(expiresAt).toISOString()}`];
      }
      case 'unpair': {
        const client = need(context);
        if (!(client instanceof FakeDesktop)) return ['unpair is for the desktop role'];
        await client.unpairPhone();
        return ['phone unpaired'];
      }
      case 'scan': {
        const client = need(context);
        if (!(client instanceof FakePhone)) return ['scan is for the phone role'];
        if (!argument) return ['usage: scan <raw>'];
        return [json(await client.scanQr(argument))];
      }
      default:
        return [`unknown command "${command}"; try help`];
    }
  } catch (error) {
    return [`error: ${error instanceof Error ? error.message : String(error)}`];
  }
}
