import { fileURLToPath } from 'node:url';
import { createContentRepo } from '@hs/core/content';

const root = fileURLToPath(new URL('../content/scenarios/', import.meta.url));
try {
  const repo = createContentRepo(root);
  const scenarios = repo.listScenarios();
  if (scenarios.length === 0) throw new Error('No scenario directories found.');
  for (const { id } of scenarios) {
    try {
      repo.load(id);
      console.log(`OK ${id}`);
    } catch (error) {
      console.error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
