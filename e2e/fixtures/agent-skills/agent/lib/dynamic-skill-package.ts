import { mockModel } from "eve/evals";

export const DYNAMIC_PACKAGE_NAME = "dynamic-package";
export const DYNAMIC_PACKAGE_MARKDOWN_TOKEN = "dynamic-package-loaded-C7F2";
export const DYNAMIC_PACKAGE_FILE_TOKEN = "dynamic-package-reference-H9R4";
export const DYNAMIC_PACKAGE_REFERENCE = "references/checklist.md";
export const DYNAMIC_PACKAGE_REQUESTS = {
  handle:
    "Alice is preparing a release. Load the dynamic package skill, then read its checklist through the skill handle.",
  filesystem:
    "Bob is preparing a release. Load the dynamic package skill, then read its checklist with read_file.",
};

export const dynamicSkillPackageModel = mockModel({
  modelId: "dynamic-skill-package-check",
  respond(request) {
    const loaded = request.toolResults.find((entry) => entry.name === "load_skill");
    if (loaded === undefined) {
      return { toolCalls: [{ name: "load_skill", input: { skill: DYNAMIC_PACKAGE_NAME } }] };
    }
    if (loaded.isError) return JSON.stringify(loaded.output);

    const useHandle = request.userMessages.includes(DYNAMIC_PACKAGE_REQUESTS.handle);
    const toolName = useHandle ? "read_skill_reference" : "read_file";
    const reference = request.toolResults.find((entry) => entry.name === toolName);
    if (reference === undefined) {
      return {
        toolCalls: [
          {
            name: toolName,
            input: useHandle
              ? {}
              : {
                  filePath: `$HOME/.agents/skills/${DYNAMIC_PACKAGE_NAME}/${DYNAMIC_PACKAGE_REFERENCE}`,
                },
          },
        ],
      };
    }
    return JSON.stringify(reference.output);
  },
});
