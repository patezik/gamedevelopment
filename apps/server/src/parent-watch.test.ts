import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchParentProcess } from './parent-watch.ts';

describe('watchParentProcess', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onGone once after the parent disappears', () => {
    let alive = true;
    const onGone = vi.fn();
    watchParentProcess('123', onGone, { intervalMs: 100, isAlive: () => alive });
    vi.advanceTimersByTime(300);
    expect(onGone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a valid pid', () => {
    const onGone = vi.fn();
    for (const pid of [undefined, '', 'abc', '0', '-5', '1.5']) {
      watchParentProcess(pid, onGone, { intervalMs: 10, isAlive: () => false });
    }
    vi.advanceTimersByTime(1000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('stop cancels the watch', () => {
    const onGone = vi.fn();
    const stop = watchParentProcess('1', onGone, { intervalMs: 10, isAlive: () => false });
    stop();
    vi.advanceTimersByTime(1000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('treats the current process as alive with the default check', () => {
    const onGone = vi.fn();
    const stop = watchParentProcess(String(process.pid), onGone, { intervalMs: 10 });
    vi.advanceTimersByTime(100);
    stop();
    expect(onGone).not.toHaveBeenCalled();
  });
});
