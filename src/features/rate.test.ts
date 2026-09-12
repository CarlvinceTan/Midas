import assert from "node:assert/strict";
import { test } from "node:test";
import { RateDisplay } from "./rate.ts";
import { formatRate } from "../ui/components/footer.ts";

test("RateDisplay fills in from zero and settles on the measured value", () => {
  const display = new RateDisplay();
  assert.equal(display.value, null);
  // First tick slides up from zero rather than snapping to the target.
  assert.equal(display.step(100), true);
  assert.equal(display.value, 1);
  // It keeps moving between ticks and never overshoots the target.
  const seen: number[] = [];
  for (let i = 0; i < 200; i++) {
    display.step(100);
    assert.ok(display.value !== null && display.value <= 100);
    seen.push(display.value);
  }
  assert.ok(seen.some((v) => v > 1 && v < 100), "passes through intermediate values");
  assert.equal(Math.round(display.value!), 100);
  // Once settled it stops requesting renders.
  assert.equal(display.step(100), false);
});

test("RateDisplay eases back down when the target drops", () => {
  const display = new RateDisplay();
  display.step(80);
  display.step(80);
  // Jump straight to a settled 80.
  while (display.step(80)) {
    /* ease */
  }
  assert.equal(Math.round(display.value!), 80);
  assert.equal(display.step(20), true);
  assert.ok(display.value! > 20 && display.value! < 80);
});

test("RateDisplay ignores a missing target", () => {
  const display = new RateDisplay();
  assert.equal(display.step(null), false);
  assert.equal(display.value, null);
});

test("formatRate shows a decimal below 100 and rounds above", () => {
  assert.equal(formatRate(83.42), "83.4");
  assert.equal(formatRate(8.4), "8.4");
  assert.equal(formatRate(0.7), "0.7");
  assert.equal(formatRate(150.6), "151");
  assert.equal(formatRate(0), "0");
});
