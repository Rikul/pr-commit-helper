const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown };
  const s = typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : undefined;
  return s;
}

export function isRetryable(err: unknown): boolean {
  const s = statusOf(err);
  if (s === undefined) {
    const code = (err as { code?: unknown })?.code;
    return typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
  }
  return s === 408 || s === 429 || s >= 500;
}

/** Retries on 408/429/5xx and network errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 2000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !isRetryable(err)) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
}
