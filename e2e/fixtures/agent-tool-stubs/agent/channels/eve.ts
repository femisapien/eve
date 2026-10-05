import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [vercelOidc(), localDev()],
  // This isolated fixture has no external services or production data.
  allowToolStubs: () => true,
});
