/**
 * Rate limits for sign-in, sign-up, password reset and the HTTP API. Counts live in API memory, per process: a restart clears them,
 * and with several API instances each one counts on its own. Every limit has a safe default and an environment setting (see README).
 */

export type RateLimitSettings = {
  /** Failed sign-ins for one account before it is locked (SIGN_IN_MAX_FAILURES, default 5). */
  signInMaxFailures: number;
  /** How long an account or address stays locked, in minutes; also the window in which failures count (SIGN_IN_LOCK_MINUTES, default 15). */
  signInLockMinutes: number;
  /** Failed sign-ins from one address, across all accounts, before that address is locked (SIGN_IN_ADDRESS_MAX_FAILURES, default 50). */
  signInAddressMaxFailures: number;
  /** Sign-up requests per address per hour (SIGN_UP_REQUESTS_PER_HOUR, default 20). */
  signUpPerAddressPerHour: number;
  /** Password reset requests per address per hour (PASSWORD_RESET_REQUESTS_PER_HOUR, default 10). */
  resetPerAddressPerHour: number;
  /** Requests per minute for one API token, one Run token or one OAuth grant on /actions (API_REQUESTS_PER_MINUTE, default 600). */
  apiRequestsPerMinute: number;
};

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  signInMaxFailures: 5,
  signInLockMinutes: 15,
  signInAddressMaxFailures: 50,
  signUpPerAddressPerHour: 20,
  resetPerAddressPerHour: 10,
  apiRequestsPerMinute: 600,
};

const SETTING_BOUNDS: Record<keyof RateLimitSettings, { variable: string; min: number; max: number }> = {
  signInMaxFailures: { variable: "SIGN_IN_MAX_FAILURES", min: 1, max: 100 },
  signInLockMinutes: { variable: "SIGN_IN_LOCK_MINUTES", min: 1, max: 1440 },
  signInAddressMaxFailures: { variable: "SIGN_IN_ADDRESS_MAX_FAILURES", min: 1, max: 10_000 },
  signUpPerAddressPerHour: { variable: "SIGN_UP_REQUESTS_PER_HOUR", min: 1, max: 10_000 },
  resetPerAddressPerHour: { variable: "PASSWORD_RESET_REQUESTS_PER_HOUR", min: 1, max: 1_000 },
  apiRequestsPerMinute: { variable: "API_REQUESTS_PER_MINUTE", min: 1, max: 100_000 },
};

/** Reads the environment. An unset or invalid value keeps its default; an invalid one also logs a startup warning. */
export function rateLimitSettings(env: Record<string, string | undefined> = Bun.env): RateLimitSettings {
  const settings = { ...DEFAULT_RATE_LIMITS };
  for (const key of Object.keys(SETTING_BOUNDS) as (keyof RateLimitSettings)[]) {
    const { variable, min, max } = SETTING_BOUNDS[key];
    const raw = env[variable];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= min && parsed <= max) settings[key] = parsed;
    else console.warn(`Ignoring invalid ${variable}=${raw}; expected an integer from ${min} to ${max}.`);
  }
  return settings;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** Delay before the next sign-in attempt on an account grows from this many failures: 2 s, 4 s, 8 s ... up to 30 s. */
const DELAY_AFTER_FAILURES = 3;
const MAX_DELAY_SECONDS = 30;
const SWEEP_AT = 5_000;

/** The address a request came from. Without trusted proxies every caller shares one bucket, so set TRUSTED_PROXY_HOPS behind a proxy. */
export function clientAddress(request: Request, trustedProxyHops: number): string {
  if (trustedProxyHops <= 0) return "direct";
  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return forwarded[forwarded.length - trustedProxyHops] ?? "direct";
}

/** Sliding-window counter: at most `limit` hits per key in each `windowMs`. */
export function createWindowCounter(now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((time) => time > at - windowMs);
      if (hits.size > SWEEP_AT) {
        for (const [other, times] of hits) if (!times.some((time) => time > at - windowMs)) hits.delete(other);
      }
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + windowMs - at) / 1000)) };
      }
      recent.push(at);
      hits.set(key, recent);
      return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },
  };
}

export type SignInRefusal = { code: "SIGN_IN_LOCKED" | "SIGN_IN_WAIT"; retryAfterSeconds: number };

type ThrottleState = { failures: number; windowStart: number; lockedUntil: number; nextAllowedAt: number };

/**
 * Failed sign-ins per account and per address. An account slows down after a few failures (a growing wait), then locks for
 * SIGN_IN_LOCK_MINUTES. An address locks the same way across all accounts. A lock or wait is temporary, so it always ends by itself.
 * Refused attempts are not counted as failures, so attempts made during a lock cannot extend it. The refusal never says whether
 * the account exists: it depends on the typed email text and the address only.
 */
export function createSignInThrottle(settings: RateLimitSettings, now: () => number = Date.now) {
  const windowMs = settings.signInLockMinutes * MINUTE_MS;
  const accounts = new Map<string, ThrottleState>();
  const addresses = new Map<string, ThrottleState>();

  function fresh(state: ThrottleState | undefined, at: number): ThrottleState {
    if (state && at - state.windowStart < windowMs && (state.lockedUntil === 0 || at < state.lockedUntil)) return state;
    return { failures: 0, windowStart: at, lockedUntil: 0, nextAllowedAt: 0 };
  }

  function sweep(at: number) {
    if (accounts.size + addresses.size < SWEEP_AT) return;
    for (const map of [accounts, addresses]) {
      for (const [key, state] of map) if (at - state.windowStart >= windowMs && at >= state.lockedUntil && at >= state.nextAllowedAt) map.delete(key);
    }
  }

  return {
    /** Null when a sign-in attempt may be checked against the password; otherwise the refusal to send. */
    check(email: string, address: string): SignInRefusal | null {
      const at = now();
      sweep(at);
      const locked = (map: Map<string, ThrottleState>, key: string) => {
        const state = map.get(key);
        return state && at < state.lockedUntil ? Math.ceil((state.lockedUntil - at) / 1000) : null;
      };
      const addressWait = locked(addresses, `address:${address}`);
      if (addressWait !== null) return { code: "SIGN_IN_LOCKED", retryAfterSeconds: addressWait };
      if (email) {
        const accountWait = locked(accounts, `account:${email}`);
        if (accountWait !== null) return { code: "SIGN_IN_LOCKED", retryAfterSeconds: accountWait };
        const delay = accounts.get(`account:${email}`);
        if (delay && at < delay.nextAllowedAt) return { code: "SIGN_IN_WAIT", retryAfterSeconds: Math.ceil((delay.nextAllowedAt - at) / 1000) };
      }
      return null;
    },
    /** Counts one failed password check (401) for the account and the address. */
    fail(email: string, address: string) {
      const at = now();
      sweep(at);
      const record = (map: Map<string, ThrottleState>, key: string, maxFailures: number, delays: boolean) => {
        const state = fresh(map.get(key), at);
        state.failures += 1;
        if (state.failures >= maxFailures) state.lockedUntil = at + windowMs;
        else if (delays && state.failures >= DELAY_AFTER_FAILURES) {
          state.nextAllowedAt = at + Math.min(MAX_DELAY_SECONDS, 2 ** (state.failures - DELAY_AFTER_FAILURES + 1)) * 1000;
        }
        map.set(key, state);
      };
      if (email) record(accounts, `account:${email}`, settings.signInMaxFailures, true);
      record(addresses, `address:${address}`, settings.signInAddressMaxFailures, false);
    },
    /** A correct password clears the account's failures and wait. */
    succeed(email: string) {
      if (email) accounts.delete(`account:${email}`);
    },
  };
}

/** The email as typed, trimmed and lower-cased, or "" when the body has none. */
export async function submittedEmail(request: Request): Promise<string> {
  try {
    const body = await request.clone().json() as { email?: unknown };
    return typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

/** The environment variable names, for the README and .env.example checks. */
export const RATE_LIMIT_VARIABLES = Object.values(SETTING_BOUNDS).map((bound) => bound.variable);
