import { defineDynamic, defineSkill } from "eve/skills";
import {
  DYNAMIC_PACKAGE_FILE_TOKEN,
  DYNAMIC_PACKAGE_MARKDOWN_TOKEN,
  DYNAMIC_PACKAGE_REFERENCE,
} from "../lib/dynamic-skill-package";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Use when Alice or Bob asks for the dynamic package release checklist.",
        markdown: [
          "# Release checklist",
          "",
          `Read ${DYNAMIC_PACKAGE_REFERENCE} and include its reference token in your reply.`,
          "",
          DYNAMIC_PACKAGE_MARKDOWN_TOKEN,
        ].join("\n"),
        files: {
          [DYNAMIC_PACKAGE_REFERENCE]: `Confirm the release notes are ready.\n${DYNAMIC_PACKAGE_FILE_TOKEN}\n`,
        },
      }),
  },
});
