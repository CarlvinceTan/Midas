/**
 * Live generation speed in tokens/second.
 *
 * Unlike cumulative throughput (`output / total span`), this measures the rate
 * over each recent sampling window, so prefill and tool waits don't drag the
 * reading down. When a window has no new output (idle/prefill), the last
 * reading is held instead of averaged toward zero — that is what caused the
 * `100 -> 0 -> 90 -> 0` roller-coaster. Streamed characters are scaled by a
 * learned chars/token ratio; provider usage calibrates that ratio over time.
 */
const SAMPLE_MS = 250;
/** Windows longer than this are treated as idle and skipped, not averaged. */
const MAX_GAP_MS = 1500;
const DEFAULT_RATIO = 3.8;
const MAX_RATE = 2000;
/** Ignore windows with too few tokens: they are noise, not a speed reading. */
const MIN_WINDOW_TOKENS = 2;
/** EMA weight for each new window; lower is smoother. */
const SMOOTHING = 0.3;

export class GenerationRate {
  rate: number | null = null;
  private key = "";
  private ratios = new Map<string, number>();
  private startedAt = 0;
  private lastSampleAt = 0;
  private lastSampleChars = 0;
  private chars = 0;

  start(key: string, now = performance.now(), _allowLiveEstimate = true): void {
    if (key !== this.key) this.rate = null;
    this.key = key;
    this.startedAt = now;
    this.lastSampleAt = now;
    this.lastSampleChars = 0;
    this.chars = 0;
  }

  /** Feed streamed character deltas; sampling happens at most every SAMPLE_MS. */
  add(count: number, now: number): void {
    if (count <= 0) return;
    this.chars += count;
    const dt = now - this.lastSampleAt;
    if (dt < SAMPLE_MS) return;
    const windowChars = this.chars - this.lastSampleChars;
    this.lastSampleAt = now;
    this.lastSampleChars = this.chars;
    // A long gap means idle (prefill, tools): hold the last reading.
    if (dt > MAX_GAP_MS || windowChars <= 0) return;
    const tokens = windowChars / (this.ratios.get(this.key) ?? DEFAULT_RATIO);
    if (tokens < MIN_WINDOW_TOKENS) return;
    const instant = tokens / (dt / 1000);
    if (!Number.isFinite(instant) || instant <= 0 || instant >= MAX_RATE) return;
    this.rate = this.rate === null ? instant : this.rate * (1 - SMOOTHING) + instant * SMOOTHING;
  }

  finish(output: number | undefined, calibrate: boolean, now = performance.now()): void {
    const seconds = (now - this.startedAt) / 1000;
    // Learn a chars/token ratio only where the streamed content represents the
    // billed output; hidden reasoning would otherwise skew later live estimates.
    if (calibrate && Number.isFinite(output) && output && output >= 32 && this.chars >= 128 && seconds >= 1) {
      const ratio = this.chars / output;
      if (ratio >= 1 && ratio <= 12) {
        const old = this.ratios.get(this.key);
        this.ratios.set(this.key, old === undefined ? ratio : old * 0.75 + ratio * 0.25);
      }
    }
    // Keep the live active-generation reading; only fall back to span throughput
    // when no live sample was possible (e.g. a model that streams no text).
    if (this.rate !== null) return;
    if (!Number.isFinite(output) || !output || output <= 0 || seconds <= 0) return;
    const measured = output / seconds;
    if (Number.isFinite(measured) && measured > 0 && measured < MAX_RATE) this.rate = measured;
  }
}

/** Presentation only: quickly ease toward the latest measured speed. */
export class RateDisplay {
  value: number | null = null;

  reset(): void {
    this.value = null;
  }

  step(target: number | null): boolean {
    if (target === null || !Number.isFinite(target)) return false;
    const goal = Math.max(0, target);
    if (this.value === null) {
      // Fill in from zero so the first reading slides up instead of snapping.
      this.value = Math.min(1, goal);
      return true;
    }
    const gap = goal - this.value;
    if (Math.abs(gap) < 0.05) {
      if (this.value === goal) return false;
      this.value = goal;
      return true;
    }
    // Continuous exponential approach: the number visibly fills between
    // readings but still settles on the measured value (no fake jitter).
    this.value += gap * 0.18;
    return true;
  }
}
