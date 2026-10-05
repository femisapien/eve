// eve-self-modification: generated-v1 digest:b9e1a89817caaed23f8098b9a87b7e24f203f7f341cc851f664a73ba451d4633
import selfModification from "eve/self-modification/deployed";

export default selfModification({
  // Keep delegation disabled until setup configures the repository and authorization policy.
  authorize: () => false,
  github: {
    repository: "your-org/your-repo",
    connector: "github/your-connector",
  },
  directory: ".",
  baseBranch: "main",
  // model: "provider/model",
  // reasoning: "high",
});
