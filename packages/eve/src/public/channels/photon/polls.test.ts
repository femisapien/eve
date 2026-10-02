import { describe, expect, it, vi } from "vitest";

import type { InputRequest } from "#shared/input.js";
import { pollInputRequested } from "#public/channels/photon/polls.js";

function request(requestId: string, labels: readonly string[]): InputRequest {
  return {
    kind: "question",
    options: labels.map((label) => ({ id: label, label })),
    prompt: `Question ${requestId}?`,
    requestId,
  } as InputRequest;
}

describe("pollInputRequested", () => {
  it("asks requests that fit a poll as polls and posts the rest as numbered text", async () => {
    const openModal = vi.fn();
    const post = vi.fn();
    const channel = {
      bot: { getAdapter: () => ({ openModal }) },
      thread: { id: "imessage:chat", post },
    };
    const event = {
      requests: [
        request("pollable", ["Saturday", "Sunday"]),
        request("open", []),
        request(
          "too-many",
          Array.from({ length: 11 }, (_, index) => `Option ${index + 1}`),
        ),
      ],
    };

    await pollInputRequested(event as never, channel as never, {} as never);

    expect(openModal).toHaveBeenCalledOnce();
    expect(openModal.mock.calls[0]?.[1]).toMatchObject({
      children: [{ options: [{ label: "Saturday" }, { label: "Sunday" }] }],
      title: "Question pollable?",
    });
    expect(post).toHaveBeenCalledOnce();
    const fallback = post.mock.calls[0]?.[0].fallbackText as string;
    expect(fallback).toContain("Question open?");
    expect(fallback).toContain("11. Option 11");
    expect(fallback).not.toContain("Question pollable?");
  });
});
