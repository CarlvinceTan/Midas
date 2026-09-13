import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionController, shouldSteer, steerPrompt } from "./session.ts";

function session(id: string, title: string) {
  return { id, projectID: "p", directory: "/x", title, version: "1", time: { created: 0, updated: 0 } };
}

function fakeClient(stored: { id: string; title: string }) {
  return {
    session: {
      get: async () => session(stored.id, stored.title),
      messages: async () => [],
      update: async (options: { body?: { title?: string } }) => {
        stored.title = options.body?.title ?? stored.title;
        return session(stored.id, stored.title);
      },
    },
    event: {
      subscribe: async () => ({ stream: (async function* () {})() }),
    },
  };
}

test("resume restores the stored session title", async () => {
  const stored = { id: "s1", title: "Preparation for deployment" };
  const controller = new SessionController({ client: fakeClient(stored) as never, cwd: "/x" });
  await controller.resume("s1");
  assert.equal(controller.title, "Preparation for deployment");
});

test("setTitle persists the title and keeps it on the controller", async () => {
  const stored = { id: "s2", title: "" };
  const controller = new SessionController({ client: fakeClient(stored) as never, cwd: "/x" });
  await controller.resume("s2");
  await controller.setTitle("Fix the parser bug");
  assert.equal(controller.title, "Fix the parser bug");
  assert.equal(stored.title, "Fix the parser bug");
});

test("resume falls back to an empty title when the session lookup fails", async () => {
  const client = {
    session: {
      get: async () => {
        throw new Error("not found");
      },
      messages: async () => [],
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
  const controller = new SessionController({ client: client as never, cwd: "/x" });
  await controller.resume("missing");
  assert.equal(controller.title, undefined);
});

/** Records v1 `promptAsync` and v2 `v2.session.prompt` calls for prompt tests. */
function promptFake(admit: "ok" | "undefined" | "throw" = "ok") {
  const v1: Array<{ body?: Record<string, unknown> }> = [];
  const v2: Array<Record<string, unknown>> = [];
  const client = {
    session: {
      get: async () => session("s1", "t"),
      messages: async () => [],
      promptAsync: async (options: { body?: Record<string, unknown> }) => {
        v1.push(options);
      },
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
  const clientV2 = {
    v2: {
      session: {
        prompt: async (options: Record<string, unknown>) => {
          v2.push(options);
          if (admit === "throw") throw new Error("v2 route unavailable");
          if (admit === "undefined") return undefined;
          return { data: { admittedSeq: 1 } };
        },
      },
    },
  };
  return { client, clientV2, v1, v2 };
}

test("shouldSteer treats only an idle session as a fresh turn", () => {
  assert.equal(shouldSteer("idle"), false);
  assert.equal(shouldSteer("busy"), true);
  assert.equal(shouldSteer("retry"), true);
});

test("steerPrompt maps attachments to v2 file attachments", () => {
  assert.deepEqual(steerPrompt("look", [{ mime: "image/png", filename: "a.png", url: "data:image/png;base64,AA" }]), {
    prompt: { text: "look", files: [{ uri: "data:image/png;base64,AA", name: "a.png" }] },
    delivery: "steer",
  });
  assert.deepEqual(steerPrompt("plain"), { prompt: { text: "plain" }, delivery: "steer" });
});

test("a busy prompt is admitted as a v2 steer with mapped files", async () => {
  const { client, clientV2, v1, v2 } = promptFake();
  const controller = new SessionController({ client: client as never, clientV2: clientV2 as never, cwd: "/x" });
  await controller.resume("s1");
  controller.transcript.setPhase("busy");
  await controller.prompt("steer me", [{ mime: "image/png", filename: "shot.png", url: "data:image/png;base64,AAAA" }]);
  assert.equal(v1.length, 0);
  assert.deepEqual(v2, [
    {
      sessionID: "s1",
      delivery: "steer",
      prompt: { text: "steer me", files: [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }] },
    },
  ]);
});

test("an idle prompt keeps the v1 path with model and agent", async () => {
  const { client, clientV2, v1, v2 } = promptFake();
  const controller = new SessionController({ client: client as never, clientV2: clientV2 as never, cwd: "/x" });
  await controller.resume("s1");
  controller.setModel({ providerID: "anthropic", modelID: "claude-sonnet" });
  controller.setAgent("plan");
  await controller.prompt("hello");
  assert.equal(v2.length, 0);
  assert.deepEqual(v1, [
    {
      path: { id: "s1" },
      query: { directory: "/x" },
      body: {
        parts: [{ type: "text", text: "hello" }],
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
        agent: "plan",
      },
    },
  ]);
});

test("a busy prompt falls back to v1 when the v2 steer is rejected or throws", async () => {
  for (const admit of ["undefined", "throw"] as const) {
    const { client, clientV2, v1, v2 } = promptFake(admit);
    const controller = new SessionController({ client: client as never, clientV2: clientV2 as never, cwd: "/x" });
    await controller.resume("s1");
    controller.transcript.setPhase("busy");
    await controller.prompt("still delivered");
    assert.equal(v2.length, 1, `${admit}: v2 should be attempted`);
    assert.deepEqual(v1[0]?.body?.parts, [{ type: "text", text: "still delivered" }]);
  }
});

test("a busy prompt without a v2 client keeps the v1 path", async () => {
  const { client, v1 } = promptFake();
  const controller = new SessionController({ client: client as never, cwd: "/x" });
  await controller.resume("s1");
  controller.transcript.setPhase("busy");
  await controller.prompt("no v2 here");
  assert.deepEqual(v1[0]?.body?.parts, [{ type: "text", text: "no v2 here" }]);
});

test("addContext still appends without a reply and never steers", async () => {
  let pressed: Record<string, unknown> | undefined;
  const client = {
    session: {
      get: async () => session("s1", "t"),
      messages: async () => [],
      prompt: async (options: { body?: Record<string, unknown> }) => {
        pressed = options.body;
        return {};
      },
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
  const controller = new SessionController({ client: client as never, cwd: "/x" });
  await controller.resume("s1");
  await controller.addContext("imported context");
  assert.deepEqual(pressed, { parts: [{ type: "text", text: "imported context" }], noReply: true });
});
