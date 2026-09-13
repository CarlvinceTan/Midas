import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password storage for the remote link. Only a salted scrypt hash is persisted
 * (in `~/.midas/settings.json`), never the password itself: the settings file is
 * plain JSON, and the remote link grants control of a shell-capable agent.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/** Encode a password as `scrypt$N$r$p$saltB64$hashB64`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), hash.toString("base64")].join("$");
}

/** Constant-time verification against a stored `hashPassword` value. */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) return false;
  const salt = decodeBase64(parts[4]!);
  const expected = decodeBase64(parts[5]!);
  if (!salt || !expected || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodeBase64(value: string): Buffer | undefined {
  try {
    const buffer = Buffer.from(value, "base64");
    return buffer.length > 0 ? buffer : undefined;
  } catch {
    return undefined;
  }
}

/** A fresh, unguessable session token for the auth cookie. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * In-memory failed-login limiter, keyed by client address. The link is public,
 * so the password is the only gate; without a limiter it is brute-forceable.
 */
export class LoginThrottle {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 8,
    private readonly windowMs = 5 * 60_000,
  ) {}

  isLocked(key: string, now = Date.now()): boolean {
    const entry = this.attempts.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  succeed(key: string): void {
    this.attempts.delete(key);
  }
}
