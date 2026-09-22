import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  type DurableDynamicSkillPackage,
  type DynamicSkillManifest,
  DynamicSkillManifestKey,
  MaterializedDynamicSkillNamesKey,
} from "#context/keys.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#shared/shell-quote.js";
import { assertSafeSkillPackageName } from "#shared/skill-package.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

export const DynamicSkillSandboxKey = new ContextKey<{
  refresh(manifest: DynamicSkillManifest): Promise<void>;
}>("eve.dynamicSkillSandbox");

/** Reconciles dynamic files only when the sandbox is used or staged content changes. */
export function bindDynamicSkillSandbox(
  ctx: ContextContainer,
  access: SandboxAccess,
): SandboxAccess {
  let pending: Promise<unknown> = Promise.resolve();

  function serialize<T>(callback: () => Promise<T>): Promise<T> {
    const next = pending.then(callback);
    pending = next.catch(() => {});
    return next;
  }

  function managedNames(): readonly string[] {
    return ctx.get(MaterializedDynamicSkillNamesKey) ?? [];
  }

  async function reconcile(
    sandbox: SandboxSession,
    manifest: DynamicSkillManifest,
    names: readonly string[],
  ): Promise<void> {
    if (names.length === 0) return;
    const root = await resolveSandboxSkillRoot({ sandbox });
    const skills = skillsByName(manifest);

    for (const name of names) {
      assertSafeSkillPackageName(name);
      const skill = skills.get(name);
      const path = `${root}/${name}`;
      const receipt = `${root}/.eve-dynamic-skills/${name}`;
      const backupRoot = `${root}/.eve-static-skills`;
      const backup = `${backupRoot}/${name}`;
      const authored = ctx
        .get(BundleKey)
        ?.resolvedAgent?.skills.find((entry) => entry.name === name);

      if (skill === undefined) {
        await sandbox.removePath({ force: true, path: receipt });
        if (authored === undefined) {
          await sandbox.removePath({ force: true, path, recursive: true });
        } else {
          // A replacement sandbox already contains the original template files.
          await runSandboxCommand(
            sandbox,
            `if [ -d ${shellQuote(backup)} ]; then rm -rf ${shellQuote(path)} && cp -R ${shellQuote(backup)} ${shellQuote(path)} && rm -rf ${shellQuote(backup)}; fi`,
          );
        }
        ctx.set(
          MaterializedDynamicSkillNamesKey,
          managedNames().filter((entry) => entry !== name),
        );
        continue;
      }

      // Keep failed replacements discoverable by later cleanup and retries.
      ctx.set(MaterializedDynamicSkillNamesKey, [...new Set([...managedNames(), name])]);
      const revision = packageRevision(skill);
      if (await packageMatches(sandbox, path, receipt, revision, skill)) continue;

      await sandbox.removePath({ force: true, path: receipt });
      if (authored !== undefined) {
        const temporary = `${backupRoot}/.pending-${name}`;
        await runSandboxCommand(
          sandbox,
          `if [ ! -d ${shellQuote(backup)} ] && [ -d ${shellQuote(path)} ]; then mkdir -p ${shellQuote(backupRoot)} && rm -rf ${shellQuote(temporary)} && cp -R ${shellQuote(path)} ${shellQuote(temporary)} && mv ${shellQuote(temporary)} ${shellQuote(backup)}; fi`,
        );
      }
      await sandbox.removePath({ force: true, path, recursive: true });
      for (const file of skill.files) {
        await sandbox.writeBinaryFile({
          content: Buffer.from(file.content, "base64"),
          path: `${path}/${file.relativePath}`,
        });
      }
      await sandbox.writeTextFile({ content: revision, path: receipt });
    }
  }

  ctx.setVirtualContext(DynamicSkillSandboxKey, {
    refresh: (manifest) =>
      serialize(async () => {
        const previous = skillsByName(ctx.get(DynamicSkillManifestKey) ?? {});
        const next = skillsByName(manifest);
        const names = managedNames().filter(
          (name) => !samePackageFiles(previous.get(name), next.get(name)),
        );
        if (names.length === 0) return;
        const sandbox = await access.get();
        if (sandbox !== null) await reconcile(sandbox, manifest, names);
      }),
  });

  return {
    captureState: () => access.captureState(),
    ...(access.delete === undefined
      ? {}
      : {
          delete: (options: Parameters<NonNullable<SandboxAccess["delete"]>>[0]) =>
            serialize(async () => {
              await access.delete!(options);
              ctx.set(MaterializedDynamicSkillNamesKey, []);
            }),
        }),
    get: () =>
      serialize(async () => {
        const sandbox = await access.get();
        if (sandbox !== null) {
          const manifest = ctx.get(DynamicSkillManifestKey) ?? {};
          await reconcile(sandbox, manifest, [
            ...new Set([...managedNames(), ...skillsByName(manifest).keys()]),
          ]);
        }
        return sandbox;
      }),
    stop: () => access.stop(),
  };
}

function skillsByName(manifest: DynamicSkillManifest): Map<string, DurableDynamicSkillPackage> {
  return new Map(
    Object.values(manifest)
      .flat()
      .map((skill) => [skill.name, skill]),
  );
}

function samePackageFiles(
  previous: DurableDynamicSkillPackage | undefined,
  next: DurableDynamicSkillPackage | undefined,
): boolean {
  if (previous === undefined || next === undefined) return previous === next;
  return (
    previous.files.length === next.files.length &&
    previous.files.every((file, index) => {
      const other = next.files[index]!;
      return file.relativePath === other.relativePath && file.content === other.content;
    })
  );
}

async function packageMatches(
  sandbox: SandboxSession,
  path: string,
  receipt: string,
  revision: string,
  skill: DurableDynamicSkillPackage,
): Promise<boolean> {
  const previous = await sandbox.readBinaryFile({ path: receipt });
  if (previous === null || Buffer.from(previous).toString("utf8") !== revision) return false;
  // Shared writers can interleave before either writes its receipt. Check the
  // bytes inside the sandbox so a mixed package is repaired without downloading it.
  const files = skill.files.map((file) => {
    const filePath = shellQuote(`${path}/${file.relativePath}`);
    const checksum = createHash("sha256").update(Buffer.from(file.content, "base64")).digest("hex");
    return `if [ ! -f ${filePath} ]; then exit 0; fi; skill_checksum=$(sha256sum < ${filePath}) || exit $?; if [ "$skill_checksum" != '${checksum}  -' ]; then exit 0; fi`;
  });
  const matches = await runSandboxCommand(sandbox, `${files.join("; ")}; printf 'matches'`);
  return matches === "matches";
}

function packageRevision(skill: DurableDynamicSkillPackage): string {
  const files = [...skill.files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify(files.map((file) => [file.relativePath, file.content])))
    .digest("hex");
}

async function runSandboxCommand(sandbox: SandboxSession, command: string): Promise<string> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    throw new Error("Failed to reconcile dynamic skill files in the sandbox.");
  }
  return result.stdout;
}
