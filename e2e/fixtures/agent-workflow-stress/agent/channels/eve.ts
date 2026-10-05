import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [vercelOidc(), localDev()],
  // This isolated fixture admits only the harness; it has no production tools.
  allowToolStubs: () => true,
});
