import type { ModelMessage } from "ai";
import { extractHistoricalInputRequests } from "#harness/input-extraction.js";
import type { InputRequest } from "#shared/input.js";
import type { ApprovedCallResult } from "./approved-calls.js";

/** Approved siblings that a workflow continuation has not answered yet. */
export function unfinishedApprovals(messages: readonly ModelMessage[]): readonly InputRequest[] {
  const approvalIds = new Set<string>();
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-response" && part.approved) approvalIds.add(part.approvalId);
      if (part.type === "tool-result") settled.add(part.toolCallId);
    }
  }
  return [
    ...extractHistoricalInputRequests({ history: messages, requestIds: approvalIds }).values(),
  ].filter((request) => !settled.has(request.action.callId));
}

/** Replace execution's approval markers without changing the calls or settled sibling results. */
export function settleApprovedTranscript(
  messages: readonly ModelMessage[],
  requests: readonly InputRequest[],
  results: readonly ApprovedCallResult[],
): ModelMessage[] {
  const callIds = new Set(requests.map((request) => request.action.callId));
  const requestIds = new Set(requests.map((request) => request.requestId));
  const transcript: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      transcript.push({
        ...message,
        content: message.content.filter(
          (part) => part.type !== "tool-approval-request" || !callIds.has(part.toolCallId),
        ),
      });
    } else if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-approval-response" || !requestIds.has(part.approvalId),
      );
      if (content.length > 0) transcript.push({ ...message, content });
    } else {
      transcript.push(message);
    }
  }
  if (results.length > 0)
    transcript.push({ role: "tool", content: results.map(({ part }) => part) });
  return transcript;
}
