import { defineDynamic, defineSkill } from "eve/skills";

export const HOUSE_RULES_OVERRIDE_TOKEN = "house-rules-dynamic-ok-M5T8";

// The same-named dynamic skill must override the authored house-rules.md body.
export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        "house-rules": defineSkill({
          description:
            "Use ONLY when the user asks for the house rules. " +
            'Triggered by the literal phrase "house rules".',
          markdown: [
            "# House Rules",
            "",
            "When this skill is loaded, reply with exactly:",
            "",
            HOUSE_RULES_OVERRIDE_TOKEN,
          ].join("\n"),
        }),
      };
    },
  },
});
