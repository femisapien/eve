import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const MOUNT_QUERY = "?eve-mount=";
const BUILT_IN_EXTENSION = "eve/self-modification";

interface Mount {
  readonly mountId: string;
  readonly sourceRoot: string;
  readonly packageName?: string;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Isolates extension-owned source modules, but leaves ordinary dependencies shared. */
export function createExtensionMountPlugin(
  mounts: readonly Mount[],
): Record<string, unknown> | null {
  if (mounts.length === 0) return null;
  const roots = mounts.map((mount) => ({ ...mount, root: canonical(mount.sourceRoot) }));
  const byId = new Map(roots.map((mount) => [mount.mountId, mount]));
  return {
    name: "eve-extension-mount",
    async resolveId(
      this: {
        resolve: (
          source: string,
          importer?: string,
          options?: { skipSelf: boolean },
        ) => Promise<{ id: string; external?: boolean } | null>;
      },
      source: string,
      importer?: string,
    ) {
      const query = source.indexOf(MOUNT_QUERY);
      const tagged =
        query >= 0 ? decodeURIComponent(source.slice(query + MOUNT_QUERY.length)) : undefined;
      const importerQuery = importer?.indexOf(MOUNT_QUERY) ?? -1;
      const inherited =
        importerQuery >= 0
          ? decodeURIComponent(importer!.slice(importerQuery + MOUNT_QUERY.length))
          : undefined;
      const mountId = tagged ?? inherited;
      if (mountId === undefined) {
        if (importer === undefined || importer.startsWith("\0")) return undefined;
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved === null || resolved.external || resolved.id.startsWith("\0"))
          return undefined;
        const path = canonical(resolved.id.split("?")[0]!);
        const owners = roots.filter(
          (root) => path === root.root || path.startsWith(`${root.root}${sep}`),
        );
        if (owners.length > 1) {
          throw new Error(
            `Import "${source}" from "${importer}" refers to multiple extension mounts (${owners.map((owner) => owner.mountId).join(", ")}). Import it from an owned mount or contribution instead.`,
          );
        }
        return owners.length === 1
          ? { id: `${resolved.id}${MOUNT_QUERY}${encodeURIComponent(owners[0]!.mountId)}` }
          : undefined;
      }
      const mount = byId.get(mountId);
      if (mount === undefined) throw new Error(`Unknown extension mount "${mountId}".`);
      const cleanSource = query >= 0 ? source.slice(0, query) : source;
      const cleanImporter = importerQuery >= 0 ? importer!.slice(0, importerQuery) : importer;
      const builtInEntry =
        cleanSource === BUILT_IN_EXTENSION &&
        mount.mountId === "extensions/self-modification" &&
        mount.packageName === "eve"
          ? join(
              mount.sourceRoot,
              `extension${mount.sourceRoot.includes(`${sep}dist${sep}`) ? ".js" : ".ts"}`,
            )
          : undefined;
      const resolved = await this.resolve(builtInEntry ?? cleanSource, cleanImporter, {
        skipSelf: true,
      });
      if (resolved === null || resolved.external || resolved.id.startsWith("\0")) return resolved;
      const path = canonical(resolved.id.split("?")[0]!);
      if (path !== mount.root && !path.startsWith(`${mount.root}${sep}`) && tagged === undefined) {
        return resolved;
      }
      return { id: `${resolved.id}${MOUNT_QUERY}${encodeURIComponent(mountId)}` };
    },
    load(id: string) {
      const query = id.indexOf(MOUNT_QUERY);
      if (query < 0) return undefined;
      const path = id.slice(0, query);
      const extension = path.slice(path.lastIndexOf(".") + 1);
      const moduleType =
        extension === "json"
          ? "json"
          : extension === "tsx"
            ? "tsx"
            : extension === "jsx"
              ? "jsx"
              : ["ts", "mts", "cts"].includes(extension)
                ? "ts"
                : "js";
      return { code: readFileSync(path, "utf8"), moduleType };
    },
  };
}
