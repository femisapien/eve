import type {
  SessionInboxPayload,
  SessionInboxReader,
  WorkflowToolRunAgentStarted,
} from "#execution/session-inbox/inbox.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  publishWrittenEventsStep,
  writeAgentStartedStep,
} from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type { MessageStreamEvent } from "#protocol/message.js";

/**
 * Writes a run's `agent.started` as it arrives while a model step runs. The
 * step lasts as long as the model thinks, and clients follow a child from its
 * `agent.started`, so the event can't wait for the boundary.
 *
 * The step's result replaces the session state at the boundary, so a channel
 * handler or hook that changes state can't run during the step. When one
 * subscribes, the event is only written during the step, and
 * {@link publishWritten} runs the handlers once the step's result is applied,
 * where their state is kept. Every other run message waits for the boundary.
 */
export class StepAgentStarts {
  private readonly cursor: SessionStateCursor;
  private readonly inbox: SessionInboxReader;
  private readonly published = new Set<SessionInboxPayload>();
  private readonly written: MessageStreamEvent[] = [];

  constructor(inbox: SessionInboxReader, cursor: SessionStateCursor) {
    this.cursor = cursor;
    this.inbox = inbox;
  }

  async publishWhile<T>(step: Promise<T>): Promise<T> {
    const arrivals: WorkflowToolRunAgentStarted[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.inbox.onAgentStarted((message) => {
      arrivals.push(message);
      wake?.();
    });
    const stepSettled = step.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    try {
      while (true) {
        const message = arrivals.shift();
        if (message !== undefined) {
          const written = await writeAgentStartedStep({ ...this.cursor.stepState(), message });
          if (written !== undefined) this.written.push(written);
          this.published.add(message);
          continue;
        }
        const arrived = new Promise<"arrived">((resolve) => {
          wake = () => resolve("arrived");
        });
        if ((await Promise.race([stepSettled, arrived])) === "settled") break;
      }
    } finally {
      unsubscribe();
    }
    return await step;
  }

  /**
   * Runs the channel handlers and hooks of the events written during the last
   * step, in the order written. Call once the step's result is applied.
   */
  async publishWritten(): Promise<void> {
    if (this.written.length === 0) return;
    const events = this.written.splice(0);
    await this.cursor.apply(await publishWrittenEventsStep({ ...this.cursor.stepState(), events }));
  }

  /** Whether the payload was published already, so admission skips it. */
  consume(payload: SessionInboxPayload): boolean {
    return this.published.delete(payload);
  }
}
