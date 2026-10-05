import { ContextKey } from "#context/key.js";
import type { StubCall, StubResult } from "#tool-stubs/types.js";

/** Runtime-supplied playback transport; the harness does not own durability. */
export interface ToolStubPlayback {
  call(call: StubCall): Promise<StubResult>;
  fail(callId: string, error: string): Promise<void>;
}

export const ToolStubPlaybackKey = new ContextKey<ToolStubPlayback>("eve.toolStubPlayback");
