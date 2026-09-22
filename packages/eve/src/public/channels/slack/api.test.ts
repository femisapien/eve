import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Card, CardText } from "#compiled/chat/index.js";
import { decodeSlackApiBody } from "#public/channels/slack/api-encoding.js";
import {
  callSlackApi,
  createSlackTransport,
  resolveSlackApiBaseUrl,
  resolveSlackBotToken,
  resolveSlackFileBaseUrl,
  SLACK_API_BASE_URL,
  type SlackBotTokenContext,
} from "#public/channels/slack/api-transport.js";
import { buildSlackBinding } from "#public/channels/slack/api.js";

interface FetchCall {
  url: string;
  body: unknown;
  contentType: string | null;
}

function buildFetchMock(
  threadMessages: readonly Record<string, unknown>[] = [
    {
      text: "Hello from user",
      ts: "1700000000.123456",
      thread_ts: "1700000000.000001",
      user: "U01",
      files: [
        {
          id: "F1",
          name: "report.csv",
          mimetype: "text/csv",
          url_private: "https://files.slack.com/a/b/report.csv",
          size: 128,
        },
      ],
    },
    {
      text: "Hello from bot",
      ts: "1700000001.000000",
      thread_ts: "1700000000.000001",
      bot_id: "B01",
    },
  ],
): { fetch: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const contentType = init?.headers ? new Headers(init.headers).get("content-type") : null;
    const parsedBody = decodeSlackApiBody(init?.body, contentType);
    calls.push({ url, body: parsedBody, contentType });

    if (url === "https://slack.com/api/files.getUploadURLExternal") {
      return new Response(
        JSON.stringify({
          ok: true,
          upload_url: "https://files.slack.com/upload/abc",
          file_id: `F${calls.length}`,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://files.slack.com/upload/")) {
      return new Response("OK", { status: 200 });
    }
    if (url === "https://slack.com/api/files.completeUploadExternal") {
      return new Response(
        JSON.stringify({
          ok: true,
          files: [{ id: "F1", title: "report.csv" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://slack.com/api/conversations.replies") {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: threadMessages,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://slack.com/api/conversations.open") {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D777" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
      headers: { "content-type": "application/json" },
    });
  });

  return { fetch, calls };
}

describe("callSlackApi encoding", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Slack accepts form encoding on every endpoint but JSON on only a
  // subset (conversations.replies rejects JSON). Lock in form so the
  // partial-JSON endpoints don't silently break again.
  it("sends every Slack API call as application/x-www-form-urlencoded", async () => {
    for (const operation of [
      "conversations.replies",
      "conversations.history",
      "chat.postMessage",
      "chat.postEphemeral",
      "files.getUploadURLExternal",
      "files.completeUploadExternal",
      "assistant.threads.setStatus",
    ]) {
      await callSlackApi({
        botToken: "xoxb-test",
        operation,
        body: { channel: "C01", ts: "1700000000.000001" },
      });
    }

    expect(mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const call of mock.calls) {
      expect(call.contentType).toBe("application/x-www-form-urlencoded");
    }
  });
});

describe("SlackHandle.uploadFiles", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the 3-step Slack upload flow per file", async () => {
    const { slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: "T01",
    });

    const bytes = new TextEncoder().encode("hello,world\n1,2\n").buffer as ArrayBuffer;

    const result = await slack.uploadFiles(
      [{ data: bytes, filename: "report.csv", mimeType: "text/csv" }],
      { initialComment: "*Report*" },
    );

    expect(result.fileIds).toEqual(["F1"]);

    const urls = mock.calls.map((c) => c.url);
    expect(urls).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/abc",
      "https://slack.com/api/files.completeUploadExternal",
    ]);

    const getUrlBody = mock.calls[0]!.body as { filename: string; length: string };
    expect(getUrlBody.filename).toBe("report.csv");
    expect(getUrlBody.length).toBe(String(bytes.byteLength));

    expect(mock.calls[1]!.contentType).toBe("application/octet-stream");

    const completeBody = mock.calls[2]!.body as {
      channel_id: string;
      thread_ts: string;
      initial_comment: string;
      files: { id: string; title: string }[];
    };
    expect(completeBody.channel_id).toBe("C01");
    expect(completeBody.thread_ts).toBe("1.0");
    expect(completeBody.initial_comment).toBe("*Report*");
    expect(completeBody.files).toEqual([{ id: "F1", title: "report.csv" }]);
  });

  it("returns an empty result for zero files", async () => {
    const { slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const result = await slack.uploadFiles([]);
    expect(result.fileIds).toEqual([]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("accepts options.channelId and options.threadTs overrides", async () => {
    const { slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await slack.uploadFiles([{ data: Buffer.from([1, 2, 3]), filename: "x.bin" }], {
      channelId: "CXYZ",
      threadTs: "9.9",
    });

    const completeBody = mock.calls.at(-1)!.body as {
      channel_id: string;
      thread_ts: string;
    };
    expect(completeBody.channel_id).toBe("CXYZ");
    expect(completeBody.thread_ts).toBe("9.9");
  });

  it("propagates errors from files.getUploadURLExternal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await expect(
      slack.uploadFiles([{ data: Buffer.from([1]), filename: "x.bin" }]),
    ).rejects.toThrow("rate_limited");
  });
});

describe("SlackThread.post with files", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("{ markdown, files } posts markdown before uploading files", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.post({
      markdown: [
        "**Report attached**",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Net | +488 |",
      ].join("\n"),
      files: [{ data: Buffer.from([1, 2]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(posted.id).toBe("1700000001.000001");

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(post).toBeDefined();
    expect((post!.body as { markdown_text: string; thread_ts: string }).markdown_text).toContain(
      "| Metric | Value |",
    );
    expect((post!.body as { markdown_text: string; thread_ts: string }).thread_ts).toBe("1.0");

    const complete = mock.calls.find(
      (c) => c.url === "https://slack.com/api/files.completeUploadExternal",
    )!;
    expect((complete.body as { initial_comment?: string }).initial_comment).toBeUndefined();
    expect((complete.body as { channel_id: string; thread_ts: string }).channel_id).toBe("C01");
    expect((complete.body as { channel_id: string; thread_ts: string }).thread_ts).toBe("1.0");
  });

  it("{ text, files } keeps a single Slack upload comment", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.post({
      text: "*Report attached*",
      files: [{ data: Buffer.from([1, 2]), filename: "report.csv", mimeType: "text/csv" }],
    });

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(post).toBeUndefined();

    const complete = mock.calls.find(
      (c) => c.url === "https://slack.com/api/files.completeUploadExternal",
    )!;
    expect((complete.body as { initial_comment: string }).initial_comment).toBe(
      "*Report attached*",
    );
  });

  it("{ card, files } posts the card via chat.postMessage and uploads files separately", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.post({
      card: Card({ children: [CardText("Here's the data:")] }),
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(post).toBeDefined();
    expect((post!.body as { blocks: unknown[] }).blocks).toBeDefined();

    const complete = mock.calls.find(
      (c) => c.url === "https://slack.com/api/files.completeUploadExternal",
    );
    expect(complete).toBeDefined();
    expect((complete!.body as { initial_comment?: string }).initial_comment).toBeUndefined();
    expect((complete!.body as { channel_id: string; thread_ts: string }).channel_id).toBe("C01");
    expect((complete!.body as { channel_id: string; thread_ts: string }).thread_ts).toBe("1.0");
  });
});

describe("Slack outbound text", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves literal at-prefixed tokens in markdown and text posts", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });
    const mention = thread.mentionUser("U012ABC456");

    expect(mention).toBe("<@U012ABC456>");
    await thread.post({ markdown: `bump @scope/package and ping ${mention}` });
    await thread.post({ text: "email @support or ping <@U012ABC456>" });

    const posts = mock.calls.filter(
      (call) => call.url === "https://slack.com/api/chat.postMessage",
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toMatchObject({
      markdown_text: "bump @scope/package and ping <@U012ABC456>",
    });
    expect(posts[1]!.body).toMatchObject({
      text: "email @support or ping <@U012ABC456>",
    });
  });

  it("preserves literal at-prefixed tokens in file upload comments", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.post({
      text: "report for @scope/package and <@U012ABC456>",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    const complete = mock.calls.find(
      (call) => call.url === "https://slack.com/api/files.completeUploadExternal",
    );
    expect(complete?.body).toMatchObject({
      initial_comment: "report for @scope/package and <@U012ABC456>",
    });
  });
});

describe("SlackThread.refresh", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates recent messages with the eve-owned Slack thread shape", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1700000000.000001",
      teamId: undefined,
    });

    await thread.refresh();

    // conversations.replies rejects JSON; lock in the form encoding at
    // the public refresh surface so replies never get silently dropped.
    const repliesCall = mock.calls.find(
      (call) => call.url === "https://slack.com/api/conversations.replies",
    );
    expect(repliesCall?.contentType).toBe("application/x-www-form-urlencoded");

    expect(thread.recentMessages).toHaveLength(2);
    expect(thread.recentMessages[0]).toMatchObject({
      text: "Hello from user",
      markdown: "Hello from user",
      user: "U01",
      botId: undefined,
      ts: "1700000000.123456",
      threadTs: "1700000000.000001",
      isMe: false,
      raw: { files: [{ id: "F1" }] },
    });
    expect(thread.recentMessages[1]).toMatchObject({
      text: "Hello from bot",
      botId: "B01",
      ts: "1700000001.000000",
      threadTs: "1700000000.000001",
      isMe: false,
    });

    const firstMessage = thread.recentMessages[0]!;
    expect("id" in firstMessage).toBe(false);
    expect("attachments" in firstMessage).toBe(false);
    expect("author" in firstMessage).toBe(false);
    expect("metadata" in firstMessage).toBe(false);
  });

  it("extracts Block Kit and legacy attachment content for text-less replies", async () => {
    vi.unstubAllGlobals();
    mock = buildFetchMock([
      {
        text: "",
        ts: "1700000000.123456",
        thread_ts: "1700000000.000001",
        bot_id: "B01",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Alert:* Service latency is high" } },
          { type: "section", fields: [{ type: "mrkdwn", text: "Region: us-east-1" }] },
        ],
        attachments: [{ title: "Runbook", text: "Restart the pods." }],
      },
    ]);
    vi.stubGlobal("fetch", mock.fetch);

    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1700000000.000001",
      teamId: undefined,
    });

    await thread.refresh();

    const message = thread.recentMessages[0]!;
    expect(message.markdown).toContain("Service latency is high");
    expect(message.markdown).toContain("Region: us-east-1");
    expect(message.markdown).toContain("Runbook");
    expect(message.markdown).toContain("Restart the pods.");
  });

  it("survives rich_text links whose URLs contain Slack control characters", async () => {
    vi.unstubAllGlobals();
    mock = buildFetchMock([
      {
        text: "plain reply",
        ts: "1700000000.123456",
        thread_ts: "1700000000.000001",
        user: "U01",
      },
      {
        text: "",
        ts: "1700000000.123457",
        thread_ts: "1700000000.000001",
        bot_id: "B01",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "link", url: "https://example.com/?q=a|b", text: "incident link" },
                ],
              },
            ],
          },
        ],
      },
    ]);
    vi.stubGlobal("fetch", mock.fetch);

    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1700000000.000001",
      teamId: undefined,
    });

    await thread.refresh();

    expect(thread.recentMessages).toHaveLength(2);
    expect(thread.recentMessages[0]?.markdown).toBe("plain reply");
    expect(thread.recentMessages[1]?.markdown).toContain("incident link");
    expect(thread.recentMessages[1]?.markdown).toContain("https://example.com/?q=a|b");
  });

  it("shares one conversations.replies request across overlapping refreshes", async () => {
    let resolveReplies!: (response: Response) => void;
    const replies = new Promise<Response>((resolve) => {
      resolveReplies = resolve;
    });
    mock.fetch.mockImplementation(async (input: string | URL | Request) => {
      if (String(input) === "https://slack.com/api/conversations.replies") {
        return replies;
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const first = thread.refresh();
    const second = thread.refresh();

    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(mock.fetch).toHaveBeenCalledTimes(1);
    });

    resolveReplies(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [{ text: "loaded once", ts: "1.0", user: "U01" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await Promise.all([first, second]);

    expect(thread.recentMessages).toHaveLength(1);
  });

  it("starts a new request after the previous refresh completes", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.refresh();
    const firstSnapshot = thread.recentMessages;
    await thread.refresh();

    expect(
      mock.calls.filter((call) => call.url === "https://slack.com/api/conversations.replies"),
    ).toHaveLength(2);
    expect(thread.recentMessages).not.toBe(firstSnapshot);
    expect(firstSnapshot).toHaveLength(2);
  });

  it("preserves loaded messages when a later refresh fails", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });
    await thread.refresh();
    const loadedMessages = [...thread.recentMessages];
    mock.fetch.mockRejectedValueOnce(new Error("Slack unavailable"));

    await thread.refresh();

    expect(thread.recentMessages).toEqual(loadedMessages);
  });

  it("marks only replies from the bound Slack app as mine", async () => {
    mock.fetch.mockImplementation(async (input: string | URL | Request) => {
      if (String(input) === "https://slack.com/api/conversations.replies") {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              {
                app_id: "A_SELF",
                bot_id: "B_SELF",
                text: "own user-attributed reply",
                ts: "1.1",
                user: "U_SELF",
              },
              {
                app_id: "A_OTHER",
                bot_id: "B_OTHER",
                text: "other bot reply",
                ts: "1.2",
                user: "U_OTHER",
              },
              {
                app_id: "A_SELF",
                bot_id: "B_SELF",
                text: "own app-attributed reply",
                ts: "1.3",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const { thread } = buildSlackBinding({
      appId: "A_SELF",
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      botUserId: "U_SELF",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.refresh();

    expect(thread.recentMessages.map((message) => message.isMe)).toEqual([true, false, true]);
  });
});

describe("SlackThread.listParticipants", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns unique human user ids in first-appearance order", async () => {
    const mock = buildFetchMock([
      { text: "root", ts: "1.0", user: "U01" },
      { text: "bot reply", ts: "1.1", thread_ts: "1.0", user: "UAPP", bot_id: "B01" },
      { text: "second person", ts: "1.2", thread_ts: "1.0", user: "U02" },
      { text: "starter again", ts: "1.3", thread_ts: "1.0", user: "U01" },
      { text: "system message", ts: "1.4", thread_ts: "1.0" },
    ]);
    vi.stubGlobal("fetch", mock.fetch);
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await expect(thread.listParticipants()).resolves.toEqual(["U01", "U02"]);

    expect(thread.recentMessages).toHaveLength(5);
    expect(
      mock.calls.filter((call) => call.url === "https://slack.com/api/conversations.replies"),
    ).toHaveLength(1);
  });
});

describe("SlackThread.postEphemeral", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts via chat.postEphemeral with user / channel / thread_ts", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.postEphemeral("U99", { text: "psst" });

    const call = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postEphemeral");
    expect(call).toBeDefined();
    const body = call!.body as { user: string; channel: string; thread_ts: string; text: string };
    expect(body.user).toBe("U99");
    expect(body.channel).toBe("C01");
    expect(body.thread_ts).toBe("1.0");
    expect(body.text).toBe("psst");
  });
});

describe("SlackThread.postDirectMessage", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the IM conversation and posts to it without a thread_ts", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.postDirectMessage("U99", { text: "for your eyes only" });

    const open = mock.calls.find((c) => c.url === "https://slack.com/api/conversations.open");
    expect(open).toBeDefined();
    expect((open!.body as { users: string }).users).toBe("U99");

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(post).toBeDefined();
    const body = post!.body as { channel: string; thread_ts?: string; text: string };
    expect(body.channel).toBe("D777");
    expect(body.thread_ts).toBeUndefined();
    expect(body.text).toBe("for your eyes only");
    expect(posted.id).toBe("1700000001.000001");
  });
});

describe("auto-anchor on first post", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first chat.postMessage on an unanchored binding adopts its own ts as the thread root", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    expect(slack.threadTs).toBe("");

    const first = await thread.post("first reply");

    expect(first.id).toBe("1700000001.000001");
    expect(anchors).toEqual(["1700000001.000001"]);
    expect(slack.threadTs).toBe("1700000001.000001");

    // The first post itself lands at the channel root (no thread_ts in body)
    // because the anchor is set AFTER Slack assigns the ts.
    const firstCall = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage")!;
    expect((firstCall.body as { thread_ts?: string }).thread_ts).toBeUndefined();
  });

  it("subsequent posts thread under the anchored ts", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
    });

    await thread.post("first");
    await thread.post("second");
    await thread.post("third");

    const postCalls = mock.calls.filter((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(postCalls).toHaveLength(3);
    expect((postCalls[0]!.body as { thread_ts?: string }).thread_ts).toBeUndefined();
    expect((postCalls[1]!.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
    expect((postCalls[2]!.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
  });

  it("does not anchor when the binding already has a threadTs", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1700000000.000999",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.post("hello");

    expect(anchors).toEqual([]);
    expect(slack.threadTs).toBe("1700000000.000999");
  });

  it("does not anchor on postEphemeral", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.postEphemeral("U99", { text: "psst" });

    expect(anchors).toEqual([]);
    expect(slack.threadTs).toBe("");
  });

  it("anchors before uploading files for a markdown post", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.post({
      markdown: "**Report attached**",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(anchors).toEqual(["1700000001.000001"]);
    expect(slack.threadTs).toBe("1700000001.000001");

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage")!;
    expect((post.body as { thread_ts?: string }).thread_ts).toBeUndefined();

    const complete = mock.calls.find(
      (c) => c.url === "https://slack.com/api/files.completeUploadExternal",
    )!;
    expect((complete.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
  });

  it("does not anchor on an upload-only text/file post", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.post({
      text: "*Report attached*",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(anchors).toEqual([]);
    expect(slack.threadTs).toBe("");
  });

  it("enables startTyping after a post anchors the thread", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
    });

    await thread.startTyping("Pre-anchor");
    expect(
      mock.calls.find((c) => c.url === "https://slack.com/api/assistant.threads.setStatus"),
    ).toBeUndefined();

    await thread.post("anchor");
    await thread.startTyping("Post-anchor");

    const setStatus = mock.calls.find(
      (c) => c.url === "https://slack.com/api/assistant.threads.setStatus",
    );
    expect(setStatus).toBeDefined();
    expect((setStatus!.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
  });

  it("sends assistant status as plain text", async () => {
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.startTyping("**Considering turbo tasks**");

    const setStatus = mock.calls.find(
      (c) => c.url === "https://slack.com/api/assistant.threads.setStatus",
    );
    expect(setStatus?.body).toMatchObject({
      status: "Considering turbo tasks",
      loading_messages: ["Considering turbo tasks"],
    });
  });

  it("invokes onThreadTsChanged exactly once even on concurrent first-posts", async () => {
    const anchors: string[] = [];
    const { thread } = buildSlackBinding({
      transport: createSlackTransport({ botToken: "xoxb-test" }),
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await Promise.all([thread.post("a"), thread.post("b"), thread.post("c")]);

    expect(anchors).toHaveLength(1);
  });
});

describe("Slack bot token context", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes explicit identity to a context-aware token provider", async () => {
    const botToken = vi.fn((context: SlackBotTokenContext) => {
      expect(context).toEqual({ teamId: "T01" });
      return "xoxb-team-one";
    });

    await callSlackApi({
      botToken,
      context: { teamId: "T01" },
      operation: "auth.test",
      body: {},
    });

    expect(botToken).toHaveBeenCalledTimes(1);
  });

  it("keeps zero-argument token providers supported", async () => {
    const botToken = vi.fn(() => "xoxb-legacy");

    const token = await resolveSlackBotToken(botToken, { teamId: "T01" });

    expect(token).toBe("xoxb-legacy");
    expect(botToken).toHaveBeenCalledTimes(1);
  });
});

describe("api.apiBaseUrl", () => {
  it("defaults to Slack's own host", () => {
    expect(resolveSlackApiBaseUrl()).toBe(SLACK_API_BASE_URL);
    expect(resolveSlackApiBaseUrl({})).toBe(SLACK_API_BASE_URL);
  });

  it("normalizes the base to a directory so method names append to it", () => {
    expect(resolveSlackApiBaseUrl({ apiBaseUrl: "http://localhost:3000/api/slack" })).toBe(
      "http://localhost:3000/api/slack/",
    );
    expect(resolveSlackApiBaseUrl({ apiBaseUrl: "http://localhost:3000/api/slack/" })).toBe(
      "http://localhost:3000/api/slack/",
    );
  });

  it("rejects a base URL that relative resolution would mangle", () => {
    expect(() => resolveSlackApiBaseUrl({ apiBaseUrl: "/api/slack" })).toThrow(
      /must be a valid absolute URL/,
    );
    // `apiBaseUrl: process.env.FAKE_SLACK_URL ?? ""` must fail loudly
    // rather than fall back to the real workspace with the real token.
    expect(() => resolveSlackApiBaseUrl({ apiBaseUrl: "" })).toThrow(
      /must be a valid absolute URL/,
    );
    expect(() => resolveSlackApiBaseUrl({ apiBaseUrl: "https://[bad" })).toThrow(
      /must be a valid absolute URL/,
    );
    expect(() => resolveSlackApiBaseUrl({ apiBaseUrl: "file:///tmp/slack" })).toThrow(
      /must be an http: or https: URL/,
    );
    expect(() => resolveSlackApiBaseUrl({ apiBaseUrl: "https://sim.test/api?token=x" })).toThrow(
      /query string or fragment/,
    );
    expect(() => resolveSlackApiBaseUrl({ apiBaseUrl: "https://sim.test/api#frag" })).toThrow(
      /query string or fragment/,
    );
  });

  it("sends the call to the configured base and through the configured fetch", async () => {
    const calls: string[] = [];
    const apiFetch = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    await callSlackApi({
      api: { apiBaseUrl: "http://localhost:3000/api/slack", fetch: apiFetch as typeof fetch },
      body: {},
      botToken: "xoxb-test",
      operation: "auth.test",
    });

    expect(calls).toEqual(["http://localhost:3000/api/slack/auth.test"]);
  });
});

// A payload declared as an `interface` carries no implicit index
// signature, so this only compiles while the public `request` surface
// takes `object` rather than `Record<string, unknown>`.
interface InterfaceTypedPayload {
  channel: string;
  text: string;
}

describe("SlackHandle.request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts an interface-typed payload", async () => {
    const calls: unknown[] = [];
    const apiFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.body);
      return Response.json({ ok: true });
    });
    const { slack } = buildSlackBinding({
      transport: createSlackTransport({
        api: { fetch: apiFetch as unknown as typeof fetch },
        botToken: "xoxb-test",
      }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const payload: InterfaceTypedPayload = { channel: "C01", text: "hi" };
    await slack.request("chat.postMessage", payload);

    expect(calls).toEqual(["channel=C01&text=hi"]);
  });
});

describe("api.fileBaseUrl", () => {
  it("is unset until a base is configured", () => {
    expect(resolveSlackFileBaseUrl()).toBeUndefined();
    expect(resolveSlackFileBaseUrl({})).toBeUndefined();
    expect(resolveSlackFileBaseUrl({ fetch: globalThis.fetch })).toBeUndefined();
  });

  it("falls back to apiBaseUrl and normalizes both to a directory", () => {
    expect(resolveSlackFileBaseUrl({ apiBaseUrl: "https://sim.test/api" })).toBe(
      "https://sim.test/api/",
    );
    expect(
      resolveSlackFileBaseUrl({
        apiBaseUrl: "https://sim.test/api",
        fileBaseUrl: "https://cdn.test",
      }),
    ).toBe("https://cdn.test/");
  });

  it("rejects a file base the prefix match could never hit", () => {
    expect(() => resolveSlackFileBaseUrl({ fileBaseUrl: "/files" })).toThrow(
      /api\.fileBaseUrl must be a valid absolute URL/,
    );
    expect(() => resolveSlackFileBaseUrl({ fileBaseUrl: "https://cdn.test/?sig=x" })).toThrow(
      /api\.fileBaseUrl must not carry a query string or fragment/,
    );
  });
});

// `files.getUploadURLExternal` answers with an `upload_url` of the
// server's choosing, and the vendored helper POSTs the bytes to it. A
// consumer's `fetch` usually carries stand-in credentials, so it must
// not follow that pointer off the configured origin.
describe("api.fetch on the upload leg", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the upload leg on the global fetch when Slack names its own host", async () => {
    const apiCalls: string[] = [];
    const globalCalls: string[] = [];
    const apiFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      apiCalls.push(url);
      if (url.endsWith("/files.getUploadURLExternal"))
        return Response.json({
          file_id: "F1",
          ok: true,
          upload_url: "https://files.slack.com/upload/abc",
        });
      return Response.json({ files: [{ id: "F1" }], ok: true });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        globalCalls.push(String(input));
        return new Response("OK");
      }),
    );

    const { slack } = buildSlackBinding({
      transport: createSlackTransport({
        api: {
          apiBaseUrl: "http://localhost:3000/api/slack",
          fetch: apiFetch as unknown as typeof fetch,
        },
        botToken: "xoxb-test",
      }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await slack.uploadFiles([{ data: new Uint8Array([1, 2, 3]), filename: "a.bin" }]);

    expect(apiCalls).toEqual([
      "http://localhost:3000/api/slack/files.getUploadURLExternal",
      "http://localhost:3000/api/slack/files.completeUploadExternal",
    ]);
    expect(globalCalls).toEqual(["https://files.slack.com/upload/abc"]);
  });

  it("keeps an upload leg on the configured origin on api.fetch", async () => {
    const apiCalls: string[] = [];
    const apiFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      apiCalls.push(url);
      if (url.endsWith("/files.getUploadURLExternal"))
        return Response.json({
          file_id: "F1",
          ok: true,
          upload_url: "http://localhost:3000/uploads/F1",
        });
      if (url === "http://localhost:3000/uploads/F1") return new Response("OK");
      return Response.json({ files: [{ id: "F1" }], ok: true });
    });
    const globalFetch = vi.fn(() => Promise.reject(new Error("global fetch reached")));
    vi.stubGlobal("fetch", globalFetch);

    const { slack } = buildSlackBinding({
      transport: createSlackTransport({
        api: {
          apiBaseUrl: "http://localhost:3000/api/slack",
          fetch: apiFetch as unknown as typeof fetch,
        },
        botToken: "xoxb-test",
      }),
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await slack.uploadFiles([{ data: new Uint8Array([1, 2, 3]), filename: "a.bin" }]);

    expect(apiCalls).toContain("http://localhost:3000/uploads/F1");
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
