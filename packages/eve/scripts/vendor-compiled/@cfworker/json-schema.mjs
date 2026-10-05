import { fileURLToPath } from "node:url";
import { loadDeclaration } from "../_shared.mjs";

// @cfworker/json-schema 4.1.1 has five observable conformance defects.
// Keep the repairs at the shared validator, with stub-boundary regressions in
// src/tool-stubs/schema.test.ts. Fail the build if an upgrade changes the code
// being patched so these repairs must be reviewed against the new version.
function validationSemanticsPlugin() {
  const patched = new Set();
  return {
    name: "eve-json-schema-validation-semantics",
    transform(code, id) {
      const file = id.replaceAll("\\", "/").split("/@cfworker/json-schema/dist/esm/")[1];
      if (file === "dereference.js" || file === "deep-compare-strict.js") {
        const [before, after] =
          file === "dereference.js"
            ? [
                "export const ignoredKeyword = {",
                "export const ignoredKeyword = { dependentRequired: true,",
              ]
            : [
                "if (typeofa !== typeof b)",
                "if (typeofa !== typeof b || Array.isArray(a) !== Array.isArray(b))",
              ];
        if (!code.includes(before))
          throw new Error(`@cfworker/json-schema ${file} patch no longer applies.`);
        patched.add(file);
        return { code: code.replace(before, after), map: null };
      }
      if (file !== "validate.js") return null;
      const replacements = [
        ["(key in instance)", "(Object.hasOwn(instance, key))"],
        ["(dependantKey in instance)", "(Object.hasOwn(instance, dependantKey))"],
        ["$maxContains === undefined &&", ""],
        [
          "const remainder = instance % $multipleOf;\n            if (Math.abs(0 - remainder) >= 1.1920929e-7 &&\n                Math.abs($multipleOf - remainder) >= 1.1920929e-7)",
          "if (!isDecimalMultiple(instance, $multipleOf))",
        ],
      ];
      for (const [before, after] of replacements) {
        if (!code.includes(before))
          throw new Error("@cfworker/json-schema validation patch no longer applies.");
        code = code.replaceAll(before, after);
      }
      patched.add(file);
      const helper = fileURLToPath(
        new URL("../entries/@cfworker/multiple-of.mjs", import.meta.url),
      );
      return {
        code: `import { isDecimalMultiple } from ${JSON.stringify(helper)};\n${code}`,
        map: null,
      };
    },
    buildEnd() {
      if (patched.size !== 3) throw new Error("@cfworker/json-schema validation was not patched.");
    },
  };
}

/**
 * JSON Schema validator for tool schemas that arrive as plain JSON Schema
 * (MCP, OpenAPI, serialized output schemas, and eve's own framework tools).
 * It interprets schemas without code generation, so it runs anywhere eve does.
 */
export default {
  packageName: "@cfworker/json-schema",
  compiledPath: "@cfworker/json-schema",
  bundling: "standalone",
  platform: "neutral",
  plugins: [validationSemanticsPlugin()],
  declaration: await loadDeclaration("@cfworker/json-schema.d.ts"),
};
