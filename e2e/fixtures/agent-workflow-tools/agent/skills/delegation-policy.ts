import { defineDynamic, defineSkill, once } from "eve/skills";

export default defineDynamic({
  select: once,
  resolve: () =>
    defineSkill({
      description: "Policy for auditing delegated reports.",
      markdown: "DELEGATION-POLICY: preserve the child's exact report in the parent response.",
    }),
});
