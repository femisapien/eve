import { describe, expect, it, vi } from "vitest";

import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import {
  getNamedSandboxSessions,
  SandboxNameConflictError,
} from "#execution/sandbox/named-sessions.js";

// Keep the credential fallback from reading a developer's Vercel CLI auth.
vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

const tag = { key: "eve", value: "tool-session" };
const address = { name: "eve-ts-abc", tag };

function mockSandbox(name: string, status = "running") {
  return {
    name,
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stderr: vi.fn(async () => ""),
      stdout: vi.fn(async () => ""),
    })),
    status,
    tags: {},
    update: vi.fn(async () => undefined),
  };
}

function setup(sandboxModule: object) {
  const implementation = createVercelSandbox({
    createOptions: { teamId: "team", projectId: "project", token: "token" },
    createSandbox: async ({ createOptions, sandboxModule: module }) =>
      await (module as any).Sandbox.create(createOptions),
    loadSandboxModule: async () => sandboxModule as never,
  });
  const named = getNamedSandboxSessions(implementation as never);
  if (named === undefined) throw new Error("expected named sessions");
  const context = {
    host: {},
    log: { debug() {}, error() {}, info() {}, warn() {} },
    session: { id: "ts_abc" },
    storagePath: "/tmp/unused",
  } as never;
  return { context, named };
}

describe("Vercel named sandbox sessions", () => {
  it("creates with the tool-session tag and never gets first", async () => {
    const created = mockSandbox(address.name);
    const Sandbox = { create: vi.fn(async () => created), get: vi.fn(async () => null) };
    const { context, named } = setup({ Sandbox });

    await named.create(context, undefined, { snapshotId: "snap" }, address);

    expect(Sandbox.get).not.toHaveBeenCalled();
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: address.name,
        tags: expect.objectContaining({ eve: "tool-session", sessionId: "ts_abc" }),
      }),
    );
  });

  it("maps a 409 on create to SandboxNameConflictError", async () => {
    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    const Sandbox = {
      create: vi.fn(async () => {
        throw conflict;
      }),
      get: vi.fn(async () => null),
    };
    const { context, named } = setup({ Sandbox });

    await expect(
      named.create(context, undefined, { snapshotId: "snap" }, address),
    ).rejects.toBeInstanceOf(SandboxNameConflictError);
  });

  it("finds by name and reports whether it was already running", async () => {
    const stopped = mockSandbox(address.name, "stopped");
    const Sandbox = { create: vi.fn(), get: vi.fn(async () => stopped) };
    const { context, named } = setup({ Sandbox });

    const found = await named.find(context, { snapshotId: "snap" }, address);

    expect(found?.running).toBe(false);
    expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({ name: address.name }));
    expect(stopped.runCommand).toHaveBeenCalled();
  });

  it("lists by tag with the latest use time", async () => {
    const list = vi.fn(async () =>
      (async function* () {
        yield { name: "a", status: "stopped", statusUpdatedAt: 50, updatedAt: 20 };
        yield { name: "b", status: "running", updatedAt: 30 };
      })(),
    );
    const { context, named } = setup({ Sandbox: { list } });

    const summaries = await named.list(context, tag);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ tags: { eve: "tool-session" } }));
    expect(summaries).toEqual([
      { lastUsedAt: 50, name: "a", running: false },
      { lastUsedAt: 30, name: "b", running: true },
    ]);
  });
});
