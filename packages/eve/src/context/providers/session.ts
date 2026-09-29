import {
  AuthKey,
  InitiatorAuthKey,
  ParentSessionKey,
  type Session,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import type { ContextReader } from "#context/key.js";
import type { HarnessSession } from "#harness/types.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { activeTurnId, readTurnState } from "#harness/turn-state.js";

export const sessionProvider = {
  key: SessionKey,
  create(ctx: ContextReader, session: Pick<HarnessSession, "state">) {
    const currentAuth = ctx.require(AuthKey);
    const turnState = readTurnState(session.state);
    const turnId = activeTurnId(turnState);

    return {
      value: Object.freeze({
        auth: {
          current: currentAuth,
          initiator: ctx.get(InitiatorAuthKey) ?? currentAuth,
        },
        parent: ctx.get(ParentSessionKey),
        sessionId: ctx.require(SessionIdKey),
        turn: { id: turnId, sequence: turnState.sequence },
      }),
    };
  },
} satisfies FrameworkContextProvider<Session>;
