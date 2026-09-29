import { z } from "#compiled/zod/index.js";

export const entryModuleBackingSchema = z
  .object({
    kind: z.literal("entry"),
    sourcePath: z.string(),
    registration: z.string(),
    externalDependencies: z.array(z.string()).readonly(),
    projection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("config") }).strict(),
      z.object({ kind: z.literal("string-instructions") }).strict(),
      z
        .object({
          kind: z.literal("member"),
          category: z.enum(["instructions", "tools", "skills", "channels"]),
          key: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();
