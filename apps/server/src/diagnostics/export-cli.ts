import { writeFileSync } from 'node:fs';
import { ExportError, USAGE, exportRepro, parseExportArguments } from './export.ts';

try {
  const { sessionId, baseUrl, out, token } = parseExportArguments(
    process.argv.slice(2),
    process.env,
  );
  const bundle = await exportRepro({ baseUrl, sessionId, token });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  if (out) {
    // The bundle contains the solution: readable by its owner only.
    writeFileSync(out, text, { mode: 0o600 });
    console.error(`Wrote ${out} (${text.length} bytes, state ${bundle.stateHash.slice(0, 12)})`);
  } else {
    process.stdout.write(text);
  }
} catch (error) {
  if (!(error instanceof ExportError)) throw error;
  console.error(`${error.message}\n\n${USAGE}`);
  process.exitCode = 2;
}
