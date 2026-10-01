import { posix } from "node:path";

import {
  createDiskSkillFileSource,
  SERVER_OUTPUT_SKILLS_DIRECTORY,
  SERVER_OUTPUT_SKILLS_URL_GLOBAL,
} from "#channel/skill-files.js";

interface EmitAssetContext {
  emitFile(file: { fileName: string; source: Uint8Array; type: "asset" }): string;
}

interface ServerOutputSkillFilesPlugin {
  readonly name: string;
  generateBundle(this: EmitAssetContext): Promise<void>;
  renderChunk(
    code: string,
    chunk: { readonly fileName: string; readonly isEntry: boolean },
  ): { code: string; map: null } | null;
}

/**
 * Ships the root agent's materialized skills tree as plain files in the
 * server build output, so bundled deployments read skill files with the same
 * disk source as dev.
 *
 * Files are emitted as bundler assets under
 * {@link SERVER_OUTPUT_SKILLS_DIRECTORY} rather than copied afterwards: the
 * bundler writes them before Nitro's Vercel preset copies the server output
 * into route-specific functions, and they stay out of `publicAssets`, so they
 * are never served as static HTTP. Only files the disk source lists are
 * emitted, so symlinks in the compiled tree are not carried over.
 *
 * Each entry chunk records where the tree is relative to itself, because the
 * output can be moved or deployed after the build.
 */
export function createServerOutputSkillFilesPlugin(input: {
  /** The materialized `skills/` directory of the root agent's workspace resources. */
  readonly skillsRoot: string;
  readonly skills: readonly string[];
}): ServerOutputSkillFilesPlugin {
  const source = createDiskSkillFileSource(input.skillsRoot);
  return {
    name: "eve-server-output-skill-files",
    async generateBundle() {
      for (const skill of input.skills) {
        for (const path of await source.listFiles(skill)) {
          this.emitFile({
            fileName: `${SERVER_OUTPUT_SKILLS_DIRECTORY}/${skill}/${path}`,
            source: await source.readFile(skill, path),
            type: "asset",
          });
        }
      }
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      const relativeUrl = `./${posix.relative(posix.dirname(chunk.fileName), SERVER_OUTPUT_SKILLS_DIRECTORY)}/`;
      // Prepended on the first line so source map line numbers stay valid.
      return {
        code: `globalThis.${SERVER_OUTPUT_SKILLS_URL_GLOBAL} = new URL(${JSON.stringify(relativeUrl)}, import.meta.url).href; ${code}`,
        map: null,
      };
    },
  };
}
