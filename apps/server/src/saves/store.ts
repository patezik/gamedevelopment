import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A save id is a file name: only characters that cannot leave the saves directory. */
const SAVE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAVE_FILE = /^([A-Za-z0-9_-]{1,64})\.json$/;
const TEMP_FILE = /\.tmp$/;

export function isSaveId(value: unknown): value is string {
  return typeof value === 'string' && SAVE_ID.test(value);
}

/** The two steps of an atomic write. Tests replace them to simulate a crash. */
export interface StoreIo {
  /** Writes `data` to a new file and makes it durable. */
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

async function writeDurably(path: string, data: string): Promise<void> {
  // The save holds the solution: owner-only on POSIX (Windows keeps the directory's ACL).
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface StoredFile {
  readonly saveId: string;
  readonly updatedAt: Date;
}

/**
 * `HS_DATA_DIR/saves/<saveId>.json` plus a small `<saveId>.meta.json` next to it. Every write goes
 * to a temporary file in the same directory and is renamed over the target, so a crash leaves
 * either the old file or the new one, never half of one.
 */
export class SaveStore {
  readonly #dir: string;
  readonly #io: StoreIo;

  constructor(dir: string, io: Partial<StoreIo> = {}) {
    this.#dir = dir;
    this.#io = { writeFile: writeDurably, rename, ...io };
  }

  async #replace(name: string, data: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const target = join(this.#dir, name);
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.#io.writeFile(temp, data);
      await this.#io.rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  write(saveId: string, json: string): Promise<void> {
    if (!isSaveId(saveId)) throw new RangeError('Invalid save id');
    return this.#replace(`${saveId}.json`, json);
  }

  writeMeta(saveId: string, meta: unknown): Promise<void> {
    if (!isSaveId(saveId)) throw new RangeError('Invalid save id');
    return this.#replace(`${saveId}.meta.json`, JSON.stringify(meta));
  }

  /** The file's text, or `undefined` when there is no such save. */
  async read(saveId: string): Promise<string | undefined> {
    if (!isSaveId(saveId)) return undefined;
    try {
      return await readFile(join(this.#dir, `${saveId}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async readMeta(saveId: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.#dir, `${saveId}.meta.json`), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async files(): Promise<StoredFile[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files: StoredFile[] = [];
    for (const name of names) {
      const saveId = SAVE_FILE.exec(name)?.[1];
      if (saveId === undefined) continue;
      const info = await stat(join(this.#dir, name)).catch(() => undefined);
      if (info?.isFile()) files.push({ saveId, updatedAt: info.mtime });
    }
    return files;
  }

  /** Deletes temporary files left by a crash in the middle of a write. */
  async removeStaleTemp(): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.#dir).catch(() => [])) {
      if (!TEMP_FILE.test(name)) continue;
      await rm(join(this.#dir, name), { force: true });
      removed++;
    }
    return removed;
  }
}
