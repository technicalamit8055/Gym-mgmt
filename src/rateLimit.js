/**
 * In-memory, per-process attempt limiter. Same tradeoff as the WebAuthn
 * challenge store in routes/biometric.js: fine for a single-process
 * deployment, resets on restart, and doesn't share state across instances.
 */
export function createLimiter({ maxAttempts, windowMs, lockoutMs }) {
  const buckets = new Map(); // key -> { count, firstAttemptAt, lockedUntil }

  function check(key) {
    const entry = buckets.get(key);
    const now = Date.now();
    if (entry?.lockedUntil && entry.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    return { locked: false };
  }

  function recordAttempt(key) {
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now - entry.firstAttemptAt > windowMs) {
      buckets.set(key, { count: 1, firstAttemptAt: now, lockedUntil: null });
      return;
    }
    entry.count += 1;
    if (entry.count >= maxAttempts) {
      entry.lockedUntil = now + lockoutMs;
    }
  }

  function recordSuccess(key) {
    buckets.delete(key);
  }

  return { check, recordAttempt, recordSuccess };
}
