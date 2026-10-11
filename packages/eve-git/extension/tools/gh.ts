import { defineDynamic, once } from "eve/tools";

import extension from "../extension.ts";
import { defineGhTool } from "../lib/gh-tool.ts";

/** Present only with `github` config; otherwise agents use `gh` from their own shell. */
export default defineDynamic({
  select: once,
  build: () =>
    extension.config.github === undefined ? null : defineGhTool(() => extension.config.github),
});
