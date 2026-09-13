import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTunnelUrl } from "./tunnel.ts";

test("parseTunnelUrl extracts the quick-tunnel hostname", () => {
  const output = [
    "2026-01-01 INF Thank you for trying Cloudflare Tunnel.",
    "2026-01-01 INF +--------------------------------------------------------------------------------------------+",
    "2026-01-01 INF |  https://brave-sunset-delta.trycloudflare.com                                     |",
  ].join("\n");
  assert.equal(parseTunnelUrl(output), "https://brave-sunset-delta.trycloudflare.com");
});

test("parseTunnelUrl ignores non-tunnel output", () => {
  assert.equal(parseTunnelUrl("still connecting..."), undefined);
  assert.equal(parseTunnelUrl("https://dash.cloudflare.com/abc"), undefined);
});

test("parseTunnelUrl returns the first URL only", () => {
  const output = "https://one.trycloudflare.com and https://two.trycloudflare.com";
  assert.equal(parseTunnelUrl(output), "https://one.trycloudflare.com");
});
