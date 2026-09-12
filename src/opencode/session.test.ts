import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionController } from "./session.ts";

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
