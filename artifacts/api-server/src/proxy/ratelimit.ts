export const MAX_CONCURRENT = 3;
export const MAX_RETRIES = 7;
export const MIN_TIMEOUT = 2000;
export const MAX_TIMEOUT = 128000;
export const FACTOR = 2;

let active = 0;
const queue: Array<() => void> = [];

export async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      resolve();
    });
  });
}

export function releaseSlot(): void {
  if (queue.length > 0) {
    const next = queue.shift()!;
    next();
  } else {
    active--;
  }
}

export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        if (err.status !== 429 || attempt === MAX_RETRIES) throw err;
        const delay = retryDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // Unreachable, but TypeScript needs it
    throw new Error("Exhausted retries");
  } finally {
    releaseSlot();
  }
}

export function retryDelay(attempt: number): number {
  return Math.min(MIN_TIMEOUT * FACTOR ** attempt, MAX_TIMEOUT);
}

export function getQueueInfo(): { active: number; queued: number } {
  return { active, queued: queue.length };
}
