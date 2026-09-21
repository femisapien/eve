import { auth } from "./auth";
import { viewerFromVerifiedSession, type SessionViewer } from "./session-identity";

const requests = new WeakMap<Request, Promise<SessionViewer | null>>();
export function sessionViewer(request: Request): Promise<SessionViewer | null> {
  let result = requests.get(request);
  if (!result) {
    result = auth.api.getSession({ headers: request.headers }).then(viewerFromVerifiedSession);
    requests.set(request, result);
  }
  return result;
}
