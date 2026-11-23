import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { FakeDesktop, FakePhone } from './roles.ts';
import { runCommand, type ReplContext } from './repl.ts';

const USAGE = `Usage: node tools/fake-client/src/cli.ts --role desktop|phone [--url http://127.0.0.1:7420]
  desktop: the session token comes from the HS_TOKEN environment variable (never from arguments)
  phone:   pair at the prompt with "pair <code>", or pass a device token in HS_TOKEN
  --session <id>   session id for REST calls before connect (optional)`;

const { values } = parseArgs({
  options: {
    role: { type: 'string' },
    url: { type: 'string', default: 'http://127.0.0.1:7420' },
    session: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || (values.role !== 'desktop' && values.role !== 'phone')) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const baseUrl = values.url;
const token = process.env['HS_TOKEN'];
const context: ReplContext = {
  role: values.role,
  baseUrl,
  client:
    token === undefined
      ? undefined
      : values.role === 'desktop'
        ? new FakeDesktop({ baseUrl, token, ...(values.session && { sessionId: values.session }) })
        : new FakePhone({ baseUrl, token }),
};

const lines = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${values.role}> `,
});
console.log('Type help for commands.');
lines.prompt();
for await (const line of lines) {
  const output = await runCommand(context, line);
  if (output === undefined) break;
  for (const text of output) console.log(text);
  lines.prompt();
}
lines.close();
