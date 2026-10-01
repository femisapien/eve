import { GATED_TOOL_CALL_WORKFLOW_NAME } from "#execution/stable-workflow-names.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/** The registered `task` body that runs an approved call to a tool from the agent's registry. */
export const GATED_TOOL_CALL_WORKFLOW_ID = `workflow//${EVE_PACKAGE_NAME}//${GATED_TOOL_CALL_WORKFLOW_NAME}`;
