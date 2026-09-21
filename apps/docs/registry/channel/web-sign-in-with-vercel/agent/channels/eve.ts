import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { sessionViewer } from "../../lib/session-viewer";
import { productionSessionStore } from "../../lib/production-session-store";
import { withSessionAccess } from "../../lib/session-access";

const channel = eveChannel({
  auth: [
    async (request) => (await sessionViewer(request))?.principal ?? null,
    vercelOidc(),
    localDev(),
  ],
});
export default withSessionAccess(channel, { viewer: sessionViewer, store: productionSessionStore });
