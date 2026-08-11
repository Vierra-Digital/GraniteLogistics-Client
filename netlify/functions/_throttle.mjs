// Attempt throttling for the credential endpoints.
//
// Passwords are scrypt-hashed, which makes each guess expensive for us as well as the
// attacker, but expensive is not the same as prevented: nothing stopped a script working
// through a password list against one address, all day, at whatever rate it liked.
//
// Counted per email, not per IP. An attacker rotates addresses trivially (any botnet, any
// proxy pool) so IP is weak evidence, whereas the target of a credential-stuffing run is
// exactly one account. The cost of that choice is that someone else's attack can lock a
// real user out for a few minutes, which is why the window is short and a correct password
// clears the counter immediately.
import { getStore } from "@netlify/blobs";

export const MAX_ATTEMPTS = 6;                 // failures allowed inside the window
export const WINDOW_MS = 15 * 60 * 1000;       // rolling window
export const LOCK_MS = 15 * 60 * 1000;         // how long a lock lasts once tripped

// Guessing a password is rate-limited to slow an attacker down without locking out a
// person who simply mistyped. Sending mail to someone else's inbox is held tighter,
// because there the request itself is the harm.
export const LOGIN_LIMITS = { max: MAX_ATTEMPTS, windowMs: WINDOW_MS, lockMs: LOCK_MS };
export const RESET_LIMITS = { max: 3, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };

function store() { return getStore({ name: "granite-throttle", consistency: "strong" }); }
const keyFor = (scope, id) => scope + ":" + String(id || "").trim().toLowerCase();

// Pure: given the stored record and now, is this caller allowed through?
// Returns { allowed } or { allowed:false, retryAfter } in seconds.
export function evaluate(record, now, limits = {}) {
  const max = limits.max || MAX_ATTEMPTS;
  const windowMs = limits.windowMs || WINDOW_MS;
  if (!record) return { allowed: true, fails: 0 };

  if (record.until && record.until > now) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((record.until - now) / 1000)) };
  }
  // The window has rolled over, so history before it is irrelevant.
  if (!record.first || record.first <= now - windowMs) return { allowed: true, fails: 0 };
  return { allowed: true, fails: record.fails || 0, max };
}

// Pure: the record to store after one more failure.
export function afterFailure(record, now, limits = {}) {
  const max = limits.max || MAX_ATTEMPTS;
  const windowMs = limits.windowMs || WINDOW_MS;
  const lockMs = limits.lockMs || LOCK_MS;

  const inWindow = record && record.first && record.first > now - windowMs;
  const fails = (inWindow ? (record.fails || 0) : 0) + 1;
  const first = inWindow ? record.first : now;
  const next = { fails, first };
  if (fails >= max) {
    next.until = now + lockMs;
    // Start the next window fresh, so a locked-out caller gets a full allowance back
    // rather than being re-locked by a single attempt.
    next.fails = 0;
    next.first = now + lockMs;
  }
  return next;
}

export async function checkThrottle(scope, id, limits) {
  try {
    const rec = await store().get(keyFor(scope, id), { type: "json" });
    return evaluate(rec, Date.now(), limits);
  } catch (e) {
    // Storage trouble must not lock everyone out of signing in.
    return { allowed: true, fails: 0 };
  }
}

export async function recordAttempt(scope, id, limits) {
  try {
    const key = keyFor(scope, id);
    const rec = await store().get(key, { type: "json" });
    const next = afterFailure(rec, Date.now(), limits);
    await store().setJSON(key, next);
    return next;
  } catch (e) { return null; }
}

export async function clearThrottle(scope, id) {
  try { await store().delete(keyFor(scope, id)); } catch (e) { /* nothing to undo */ }
}
