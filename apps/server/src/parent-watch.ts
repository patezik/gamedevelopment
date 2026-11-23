export interface ParentWatchOptions {
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Calls onGone once when the process with the given PID disappears. Returns a stop function. */
export function watchParentProcess(
  rawPid: string | undefined,
  onGone: () => void,
  { intervalMs = 2000, isAlive = processExists }: ParentWatchOptions = {},
): () => void {
  if (rawPid === undefined || !/^\d+$/.test(rawPid) || Number(rawPid) <= 0) return () => {};
  const pid = Number(rawPid);
  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
