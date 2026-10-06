import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [vercelOidc(), localDev()],
  // Allow authenticated eval callers to supply data in this isolated fixture.
  allowToolStubs: () => true,
});
