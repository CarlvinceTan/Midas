import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginThrottle, hashPassword, verifyPassword } from "./auth.ts";

test("hashPassword produces a salted, verifiable hash", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);
});

test("hashPassword salts each hash so equal passwords differ", () => {
  const a = hashPassword("same");
  const b = hashPassword("same");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same", a), true);
  assert.equal(verifyPassword("same", b), true);
});

test("verifyPassword rejects missing or malformed stores", () => {
  assert.equal(verifyPassword("x", undefined), false);
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", "scrypt$bad$8$1$c2FsdA==$aGFzaA=="), false);
  assert.equal(verifyPassword("x", "scrypt$16384$8$1$$"), false);
});

test("LoginThrottle locks after the failure cap within the window", () => {
  const throttle = new LoginThrottle(3, 1000);
  assert.equal(throttle.isLocked("ip"), false);
  throttle.fail("ip", 0);
  throttle.fail("ip", 0);
  assert.equal(throttle.isLocked("ip", 0), false);
  throttle.fail("ip", 0);
  assert.equal(throttle.isLocked("ip", 0), true);
  assert.equal(throttle.isLocked("ip", 1001), false, "window expiry clears the lock");
});

test("LoginThrottle succeed clears failures", () => {
  const throttle = new LoginThrottle(2, 1000);
  throttle.fail("ip", 0);
  throttle.succeed("ip");
  assert.equal(throttle.isLocked("ip", 0), false);
});
