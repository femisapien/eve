import { Buffer } from "node:buffer";
import { dirname } from "node:path";

import { Bash } from "just-bash";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { bindDynamicSkillSandbox, DynamicSkillSandboxKey } from "#context/dynamic-skill-sandbox.js";
import {
  type DurableDynamicSkillPackage,
  type DynamicSkillManifest,
  DynamicSkillManifestKey,
  MaterializedDynamicSkillNamesKey,
} from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SandboxWriteFileOptions } from "#shared/sandbox-session.js";

const ROOT = "/home/agent/.agents/skills";

function createSandbox(initialFiles: Record<string, string | Uint8Array> = {}) {
  const bash = new Bash({ env: { HOME: "/home/agent" }, files: initialFiles });
  const write = vi.fn(async (input: SandboxWriteFileOptions) => {
    await bash.fs.mkdir(dirname(input.path), { recursive: true });
    await bash.fs.writeFile(input.path, await streamToBuffer(input.content));
  });
  const session = buildSandboxSession({
    id: "same-logical-sandbox",
    readFile: async ({ path }) =>
      (await bash.fs.exists(path)) ? bufferToStream(await bash.fs.readFileBuffer(path)) : null,
    removePath: async (options) => await bash.fs.rm(options.path, options),
    resolvePath: (path) => (path.startsWith("/") ? path : `/workspace/${path}`),
    spawn: async ({ command }) => {
      const result = await bash.exec(command);
      return {
        kill: async () => {},
        stderr: bufferToStream(Buffer.from(result.stderr)),
        stdout: bufferToStream(Buffer.from(result.stdout)),
        wait: async () => ({ exitCode: result.exitCode }),
      };
    },
    writeFile: write,
  });
  const access: SandboxAccess = {
    captureState: async () => ({ initialized: true, session: null }),
    get: vi.fn(async () => session),
    stop: async () => {},
  };
  return { access, bash, session, write };
}

function skill(
  name: string,
  files: Record<string, string | Uint8Array> = {},
  markdown = `# ${name}`,
): DurableDynamicSkillPackage {
  return {
    description: name,
    files: Object.entries({ "SKILL.md": markdown, ...files })
      .map(([relativePath, content]) => ({
        content: Buffer.from(content).toString("base64"),
        relativePath,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    markdown,
    name,
  };
}

function bind(manifest: DynamicSkillManifest, sandbox = createSandbox()) {
  const ctx = new ContextContainer();
  ctx.set(DynamicSkillManifestKey, manifest);
  const access = bindDynamicSkillSandbox(ctx, sandbox.access);
  return { access, ctx, sandbox };
}

function packageWrites(sandbox: ReturnType<typeof createSandbox>) {
  return sandbox.write.mock.calls
    .map(([file]) => file)
    .filter((file) => !file.path.startsWith(`${ROOT}/.eve-dynamic-skills/`));
}

async function refresh(ctx: ContextContainer, manifest: DynamicSkillManifest) {
  await ctx.require(DynamicSkillSandboxKey).refresh(manifest);
  ctx.set(DynamicSkillManifestKey, manifest);
}

describe("dynamic skill sandbox reconciliation", () => {
  it("stages only on access and skips unchanged refreshes and package writes", async () => {
    const manifest = { resolver: [skill("policy", { "references/rules.txt": "rules" })] };
    const { access, ctx, sandbox } = bind(manifest);

    await refresh(ctx, manifest);
    expect(sandbox.access.get).not.toHaveBeenCalled();
    await access.get();
    expect(packageWrites(sandbox)).toHaveLength(2);

    await refresh(ctx, {
      resolver: [{ ...manifest.resolver[0]!, description: "New description" }],
    });
    expect(sandbox.access.get).toHaveBeenCalledTimes(1);
    await access.get();
    expect(packageWrites(sandbox)).toHaveLength(2);
  });

  it("replaces removed siblings and file/directory shapes without touching other packages", async () => {
    const original = skill("policy", {
      "references/keep.txt": "same",
      "references/remove.txt": "obsolete",
      shape: "was a file",
    });
    const unrelated = skill("other", { "asset.bin": new Uint8Array([0, 255, 17]) });
    const { access, ctx, sandbox } = bind({ resolver: [original, unrelated] });
    await access.get();
    sandbox.write.mockClear();

    const updated = skill("policy", {
      "references/keep.txt": "same",
      "shape/inside.bin": new Uint8Array([255, 0, 254]),
    });
    await refresh(ctx, { resolver: [updated, unrelated] });
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy/references/remove.txt`)).toBe(false);
    expect(
      Array.from(await sandbox.bash.fs.readFileBuffer(`${ROOT}/policy/shape/inside.bin`)),
    ).toEqual([255, 0, 254]);
    expect(packageWrites(sandbox).every((file) => file.path.startsWith(`${ROOT}/policy/`))).toBe(
      true,
    );

    await refresh(ctx, { resolver: [skill("policy", { shape: "file again" }), unrelated] });
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/shape`)).toBe("file again");
    expect(Array.from(await sandbox.bash.fs.readFileBuffer(`${ROOT}/other/asset.bin`))).toEqual([
      0, 255, 17,
    ]);
  });

  it("removes an omitted file even when all retained contents are identical", async () => {
    const { access, ctx, sandbox } = bind({
      resolver: [skill("policy", { "keep.txt": "same", "removed.txt": "obsolete" })],
    });
    await access.get();
    await refresh(ctx, { resolver: [skill("policy", { "keep.txt": "same" })] });
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy/removed.txt`)).toBe(false);
  });

  it("compares complete binary contents when names and descriptions are unchanged", async () => {
    const { access, ctx, sandbox } = bind({
      resolver: [skill("policy", { "asset.bin": new Uint8Array([0, 255]) })],
    });
    await access.get();
    const receipt = `${ROOT}/.eve-dynamic-skills/policy`;
    const original = await sandbox.bash.fs.readFile(receipt);
    await refresh(ctx, {
      resolver: [skill("policy", { "asset.bin": new Uint8Array([255, 0]) })],
    });
    expect(await sandbox.bash.fs.readFile(receipt)).not.toBe(original);
    expect(Array.from(await sandbox.bash.fs.readFileBuffer(`${ROOT}/policy/asset.bin`))).toEqual([
      255, 0,
    ]);
  });

  it("reuses a cold-resumed sandbox and rematerializes a replaced sandbox with the same id", async () => {
    const { access, ctx, sandbox } = bind({
      resolver: [skill("policy", { "asset.bin": new Uint8Array([0, 255]) })],
    });
    await access.get();
    const serialized = JSON.parse(JSON.stringify(serializeContext(ctx)));
    const resumed = await deserializeContext(serialized);
    await bindDynamicSkillSandbox(resumed, sandbox.access).get();
    expect(packageWrites(sandbox)).toHaveLength(2);

    const replacement = createSandbox();
    await bindDynamicSkillSandbox(await deserializeContext(serialized), replacement.access).get();
    expect(packageWrites(replacement)).toHaveLength(2);
    expect(
      Array.from(await replacement.bash.fs.readFileBuffer(`${ROOT}/policy/asset.bin`)),
    ).toEqual([0, 255]);
  });

  it("preserves generated files for shared readers and repairs missing package files", async () => {
    const { access, ctx, sandbox } = bind({ resolver: [skill("policy", { "keep.txt": "same" })] });
    await access.get();
    await bindDynamicSkillSandbox(new ContextContainer(), sandbox.access).get();
    expect(packageWrites(sandbox)).toHaveLength(2);

    await sandbox.bash.fs.rm(`${ROOT}/policy/keep.txt`);
    await access.get();
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/keep.txt`)).toBe("same");
    await sandbox.bash.fs.writeFile(`${ROOT}/policy/result.json`, "generated result");
    await access.get();
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/result.json`)).toBe("generated result");
    await refresh(ctx, { resolver: [skill("policy", { "keep.txt": "changed" })] });
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy/result.json`)).toBe(false);
  });

  it("serializes concurrent reads so a package is written once", async () => {
    const { access, sandbox } = bind({ resolver: [skill("policy", { "keep.txt": "same" })] });
    await Promise.all([access.get(), access.get(), access.get()]);
    expect(packageWrites(sandbox)).toHaveLength(2);
  });

  it("repairs mixed revisions left by concurrent writers sharing a sandbox", async () => {
    const sandbox = createSandbox();
    const first = bind(
      { resolver: [skill("policy", { "support.txt": "first" }, "# First")] },
      sandbox,
    );
    const second = bind(
      { resolver: [skill("policy", { "support.txt": "second" }, "# Second")] },
      sandbox,
    );
    const written = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const write = sandbox.write.getMockImplementation()!;
    sandbox.write.mockImplementationOnce(async (file) => {
      await write(file);
      written.resolve();
      await resume.promise;
    });

    const materializing = first.access.get();
    await written.promise;
    try {
      await second.access.get();
    } finally {
      resume.resolve();
    }
    await materializing;
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/SKILL.md`)).toBe("# Second");
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/support.txt`)).toBe("first");

    await first.access.get();
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/SKILL.md`)).toBe("# First");
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/support.txt`)).toBe("first");
    sandbox.write.mockClear();
    await first.access.get();
    expect(sandbox.write).not.toHaveBeenCalled();
  });

  it("repairs modified binary files without reading package bytes back to the runtime", async () => {
    const fileName = "references/it's a file\n.bin";
    const original = new Uint8Array([0, 255, 17]);
    const { access, sandbox } = bind({ resolver: [skill("policy", { [fileName]: original })] });
    await access.get();
    await sandbox.bash.fs.writeFile(`${ROOT}/policy/${fileName}`, new Uint8Array([255, 0, 17]));
    const read = vi.spyOn(sandbox.session, "readBinaryFile");

    await access.get();
    expect(Array.from(await sandbox.bash.fs.readFileBuffer(`${ROOT}/policy/${fileName}`))).toEqual(
      Array.from(original),
    );
    expect(read.mock.calls.map(([file]) => file.path)).toEqual([
      `${ROOT}/.eve-dynamic-skills/policy`,
    ]);
    sandbox.write.mockClear();
    await access.get();
    expect(sandbox.write).not.toHaveBeenCalled();
  });

  it("preserves package files when the checksum command fails", async () => {
    const { access, sandbox } = bind({
      resolver: [skill("policy", { "reference.txt": "original" })],
    });
    await access.get();
    await sandbox.bash.fs.writeFile(`${ROOT}/policy/reference.txt`, "modified externally");
    await sandbox.bash.fs.writeFile(`${ROOT}/policy/result.json`, "generated result");
    const run = sandbox.session.run;
    vi.spyOn(sandbox.session, "run").mockImplementation((options) =>
      run({
        ...options,
        command: options.command.replaceAll("sha256sum", "missing_checksum_command"),
      }),
    );
    sandbox.write.mockClear();

    await expect(access.get()).rejects.toThrow(
      "Failed to reconcile dynamic skill files in the sandbox.",
    );
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/reference.txt`)).toBe(
      "modified externally",
    );
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/result.json`)).toBe("generated result");
    expect(sandbox.write).not.toHaveBeenCalled();
  });

  it("tracks materialized existing packages so withdrawal removes their files", async () => {
    const sandbox = createSandbox({ [`${ROOT}/policy/SKILL.md`]: "# policy" });
    const { access, ctx } = bind({ resolver: [skill("policy")] }, sandbox);
    await access.get();
    expect(packageWrites(sandbox)).toHaveLength(1);
    expect(ctx.get(MaterializedDynamicSkillNamesKey)).toEqual(["policy"]);
    await refresh(ctx, {});
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy`)).toBe(false);
  });

  it("retries a failed partial write and removes failed materializations when withdrawn", async () => {
    const { access, ctx, sandbox } = bind({ resolver: [skill("policy", { "keep.txt": "same" })] });
    sandbox.write.mockRejectedValueOnce(new Error("write failed"));
    await expect(access.get()).rejects.toThrow("write failed");
    expect(ctx.get(MaterializedDynamicSkillNamesKey)).toEqual(["policy"]);
    expect(await sandbox.bash.fs.exists(`${ROOT}/.eve-dynamic-skills/policy`)).toBe(false);
    await access.get();
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/keep.txt`)).toBe("same");

    sandbox.write.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(
      refresh(ctx, { resolver: [skill("policy", { "next.txt": "next" })] }),
    ).rejects.toThrow("refresh failed");
    expect(await sandbox.bash.fs.exists(`${ROOT}/.eve-dynamic-skills/policy`)).toBe(false);
    expect(ctx.require(DynamicSkillManifestKey).resolver![0]!.files).toContainEqual({
      content: Buffer.from("same").toString("base64"),
      relativePath: "keep.txt",
    });
    await refresh(ctx, {});
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy`)).toBe(false);
  });

  it("retries when writing the materialization receipt fails after all package files were written", async () => {
    const { access, sandbox } = bind({ resolver: [skill("policy")] });
    sandbox.write.mockImplementationOnce(async (file) => {
      await sandbox.bash.fs.mkdir(dirname(file.path), { recursive: true });
      await sandbox.bash.fs.writeFile(file.path, await streamToBuffer(file.content));
    });
    sandbox.write.mockRejectedValueOnce(new Error("receipt failed"));
    await expect(access.get()).rejects.toThrow("receipt failed");
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy/SKILL.md`)).toBe(true);
    expect(await sandbox.bash.fs.exists(`${ROOT}/.eve-dynamic-skills/policy`)).toBe(false);
    await access.get();
    expect(packageWrites(sandbox)).toHaveLength(2);
    expect(await sandbox.bash.fs.exists(`${ROOT}/.eve-dynamic-skills/policy`)).toBe(true);
  });

  it("restores a static package and its binary supporting files after an override is removed", async () => {
    const sandbox = createSandbox({
      [`${ROOT}/policy/SKILL.md`]: "# Authored policy",
      [`${ROOT}/policy/scripts/original.bin`]: new Uint8Array([0, 255, 33]),
    });
    const { access, ctx } = bind(
      { resolver: [skill("policy", { "dynamic.txt": "dynamic" })] },
      sandbox,
    );
    ctx.set(BundleKey, {
      resolvedAgent: { skills: [{ name: "policy", markdown: "# Authored policy" }] },
    } as never);
    await access.get();
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy/scripts/original.bin`)).toBe(false);
    await refresh(ctx, {});
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/SKILL.md`)).toBe("# Authored policy");
    expect(
      Array.from(await sandbox.bash.fs.readFileBuffer(`${ROOT}/policy/scripts/original.bin`)),
    ).toEqual([0, 255, 33]);
    expect(await sandbox.bash.fs.exists(`${ROOT}/policy/dynamic.txt`)).toBe(false);
  });

  it("backs up an identical static package before another shared writer changes it", async () => {
    const sandbox = createSandbox({
      [`${ROOT}/policy/SKILL.md`]: "# policy",
      [`${ROOT}/policy/reference.txt`]: "original",
    });
    const { access, ctx } = bind(
      { resolver: [skill("policy", { "reference.txt": "original" })] },
      sandbox,
    );
    ctx.set(BundleKey, {
      resolvedAgent: { skills: [{ name: "policy", markdown: "# policy" }] },
    } as never);
    await access.get();
    expect(packageWrites(sandbox)).toHaveLength(2);
    await sandbox.bash.fs.writeFile(`${ROOT}/policy/reference.txt`, "changed elsewhere");
    await refresh(ctx, {});
    expect(await sandbox.bash.fs.readFile(`${ROOT}/policy/reference.txt`)).toBe("original");
  });
});
