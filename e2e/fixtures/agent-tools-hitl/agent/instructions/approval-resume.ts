import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({
        content: "Approval-resume ordering probe.",
        role: "user",
      }),
  },
});
