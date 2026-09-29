"use client";

import type { ConversationInput } from "eve/react";
import {
  ArrowRightIcon,
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  XIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import {
  type ActivityItem,
  type ActivityStatus,
  activityItems,
  agentThread,
  type CallTimes,
  describeInput,
  formatDuration,
  formatJson,
  inputAnswer,
  itemName,
  itemStatus,
  oneLine,
} from "./conversation-view";

/** Lets any row send the person to the dock entry for a request. */
export const FocusInputContext = createContext<(requestId: string) => void>(() => {});

// ---------------------------------------------------------------------------
// The folded row under each answer
// ---------------------------------------------------------------------------

const SUMMARY_LIMIT = 4;

export function ActivityDisclosure({ items }: { readonly items: readonly ActivityItem[] }) {
  const [open, setOpen] = useState(false);
  const statuses = items.map(itemStatus);
  const live = statuses.some((status) => status === "working");
  const names = summarizeNames(items);
  const shown = names.slice(0, SUMMARY_LIMIT);
  const hidden = names.length - shown.length;

  return (
    <div className="text-[13px]">
      <button
        aria-expanded={open}
        className="group flex max-w-full items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        {live ? (
          <Shimmer as="span" duration={1}>
            Working
          </Shimmer>
        ) : (
          <span>Activity</span>
        )}
        {shown.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {shown.map((entry) => (
              <span className="flex items-center gap-1.5" key={entry.name}>
                <span aria-hidden="true">·</span>
                <code
                  className={cn(
                    "font-mono text-[12px]",
                    entry.status === "failed" && "text-destructive",
                    entry.status === "needs-you" && "text-amber-600 dark:text-amber-500",
                  )}
                >
                  {entry.name}
                  {entry.count > 1 ? ` ×${entry.count}` : ""}
                </code>
              </span>
            ))}
            {hidden > 0 ? <span>· +{hidden}</span> : null}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1.5">
          <ActivityList depth={0} items={items} />
        </div>
      ) : (
        <PromotedLines items={items} />
      )}
    </div>
  );
}

function summarizeNames(
  items: readonly ActivityItem[],
): Array<{ readonly name: string; count: number; status: ActivityStatus }> {
  const rank: Record<ActivityStatus, number> = {
    cancelled: 1,
    denied: 1,
    done: 0,
    failed: 3,
    interrupted: 1,
    "needs-you": 4,
    working: 2,
  };
  const work = items.filter((item) => item.kind !== "reasoning" && item.kind !== "text");
  const source = work.length > 0 ? work : items;
  const entries = new Map<string, { name: string; count: number; status: ActivityStatus }>();
  for (const item of source) {
    const name = itemName(item);
    const status = itemStatus(item);
    const entry = entries.get(name);
    if (entry === undefined) {
      entries.set(name, { count: 1, name, status });
      continue;
    }
    entry.count += 1;
    if (rank[status] > rank[entry.status]) entry.status = status;
  }
  return [...entries.values()];
}

/**
 * Anything blocked on the person, or broken, stays visible while the rest is folded, and so does
 * a question the person answered, since the answer is part of the conversation.
 */
function PromotedLines({ items }: { readonly items: readonly ActivityItem[] }) {
  const focusInput = useContext(FocusInputContext);
  const lines = items.flatMap((item) => {
    const status = itemStatus(item);
    if (status === "needs-you" || status === "failed") {
      return [{ item, request: openRequestOf(item), status }];
    }
    return [];
  });
  const answered = items.flatMap((item) =>
    item.kind === "tool" &&
    item.request?.request.kind === "question" &&
    item.request.status !== "open"
      ? [{ input: item.request, item }]
      : [],
  );
  if (lines.length === 0 && answered.length === 0) return null;

  return (
    <ul className="mt-1.5 space-y-1">
      {answered.map(({ input, item }) => (
        <li className="flex min-w-0 items-center gap-2" key={item.key}>
          <StatusIcon status="done" />
          <span className="min-w-0 truncate text-muted-foreground">
            {oneLine(input.request.prompt)}
          </span>
          <Answer text={inputAnswer(input)} />
        </li>
      ))}
      {lines.map(({ item, request, status }) => (
        <li className="flex min-w-0 items-center gap-2" key={item.key}>
          <StatusIcon status={status} />
          <code className="shrink-0 font-mono text-[12px]">{itemName(item)}</code>
          <span
            className={cn(
              "min-w-0 truncate",
              status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {status === "failed"
              ? oneLine(errorTextOf(item) ?? "failed")
              : request !== undefined
                ? oneLine(request.request.prompt)
                : "needs you"}
          </span>
          {status === "needs-you" && request !== undefined ? (
            <button
              className="shrink-0 font-medium text-amber-700 hover:underline dark:text-amber-500"
              onClick={() => focusInput(request.request.requestId)}
              type="button"
            >
              Answer
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function openRequestOf(item: ActivityItem): ConversationInput | undefined {
  switch (item.kind) {
    case "tool":
      return item.request?.status === "open" ? item.request : undefined;
    case "agent":
    case "task":
      return item.inputs.find((input) => input.status === "open");
    default:
      return undefined;
  }
}

function errorTextOf(item: ActivityItem): string | undefined {
  return item.kind === "reasoning" || item.kind === "text" ? undefined : item.state.errorText;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function ActivityList({
  depth,
  items,
}: {
  readonly depth: number;
  readonly items: readonly ActivityItem[];
}) {
  return (
    <ul className="space-y-0.5" data-depth={depth}>
      {items.map((item) => (
        <li key={item.key}>
          {item.kind === "text" ? (
            <div className="py-1 text-[13px] text-foreground/80">
              <MessageResponse isAnimating={item.streaming}>{item.text}</MessageResponse>
            </div>
          ) : (
            <ActivityRow depth={depth} item={item} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({
  depth,
  item,
}: {
  readonly depth: number;
  readonly item: Exclude<ActivityItem, { kind: "text" }>;
}) {
  const [open, setOpen] = useState(false);
  const status = itemStatus(item);

  return (
    <div>
      <button
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-[13px] hover:bg-muted/50"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <StatusIcon status={status} />
        <code className="shrink-0 font-mono text-[12px] text-foreground">{itemName(item)}</code>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {open && item.kind === "agent" ? null : rowDetail(item)}
        </span>
        <RowMeta item={item} status={status} />
      </button>
      {open ? (
        <div className="mb-2 ml-[7px] border-l pt-1 pl-3">
          <RowBody depth={depth} item={item} />
        </div>
      ) : null}
    </div>
  );
}

function rowDetail(item: Exclude<ActivityItem, { kind: "text" }>): string | undefined {
  switch (item.kind) {
    case "reasoning":
      return oneLine(item.text).slice(0, 160);
    case "auth":
      return item.part.displayName;
    case "tool":
      if (item.request !== undefined && item.request.request.kind === "question") {
        return oneLine(item.request.request.prompt);
      }
      return (
        item.label ??
        describeInput(item.input) ??
        (item.state.output === undefined ? undefined : describeInput(item.state.output))
      );
    case "task":
      return item.label ?? describeInput(item.input);
    case "agent":
      return describeInput(item.input);
  }
}

function RowMeta({
  item,
  status,
}: {
  readonly item: Exclude<ActivityItem, { kind: "text" }>;
  readonly status: ActivityStatus;
}) {
  const times = item.kind === "reasoning" || item.kind === "auth" ? undefined : item.times;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
      <StatusText status={status} />
      {times === undefined ? null : <Elapsed live={status === "working"} times={times} />}
    </span>
  );
}

function RowBody({
  depth,
  item,
}: {
  readonly depth: number;
  readonly item: Exclude<ActivityItem, { kind: "text" }>;
}) {
  switch (item.kind) {
    case "reasoning":
      return (
        <div className="py-1 text-[13px] text-muted-foreground">
          <MessageResponse isAnimating={item.streaming}>{item.text}</MessageResponse>
        </div>
      );
    case "auth":
      return (
        <div className="space-y-1 py-1 text-[13px] text-muted-foreground">
          <p>{item.part.description}</p>
          {item.state.errorText ? <p>{item.state.errorText}</p> : null}
        </div>
      );
    case "tool":
      return (
        <div className="space-y-2 py-1">
          {item.request !== undefined ? <InputRecord input={item.request} /> : null}
          <Payload label="input" value={item.input} />
          {item.state.errorText !== undefined ? (
            <ErrorText text={item.state.errorText} />
          ) : item.state.output !== undefined ? (
            <Payload label="output" value={item.state.output} />
          ) : null}
        </div>
      );
    case "task":
      return (
        <div className="space-y-2 py-1">
          <p className="font-mono text-[11px] text-muted-foreground">{item.taskId}</p>
          {item.inputs.map((input) => (
            <InputRecord input={input} key={input.request.requestId} />
          ))}
          <Payload label="input" value={item.input} />
          {item.state.errorText !== undefined ? (
            <ErrorText text={item.state.errorText} />
          ) : item.state.output !== undefined ? (
            <Payload label="result" value={item.state.output} />
          ) : null}
        </div>
      );
    case "agent":
      return <AgentThreadView depth={depth} item={item} />;
  }
}

function AgentThreadView({
  depth,
  item,
}: {
  readonly depth: number;
  readonly item: Extract<ActivityItem, { kind: "agent" }>;
}) {
  const thread = agentThread(item.call);
  const message = describeInput(item.input);

  if (thread.kind === "followed") {
    const items = thread.messages.flatMap((threadMessage) =>
      activityItems(threadMessage.parts, threadMessage.metadata?.turnId, thread.context, {
        includeText: true,
      }),
    );
    return (
      <div className="space-y-1 py-1">
        {message ? <CallMessage text={message} /> : null}
        {items.length === 0 ? (
          <p className="py-1 text-[13px] text-muted-foreground">
            {item.state.status === "working" ? (
              <Shimmer as="span" duration={1}>
                Starting
              </Shimmer>
            ) : (
              "No activity."
            )}
          </p>
        ) : (
          <ActivityList depth={depth + 1} items={items} />
        )}
        {item.state.errorText !== undefined ? <ErrorText text={item.state.errorText} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 py-1">
      {message ? <CallMessage text={message} /> : null}
      <p className="text-[12px] text-muted-foreground">
        {thread.kind === "unavailable" ? "Live detail unavailable." : "Live detail not followed."}
      </p>
      {item.inputs.map((input) => (
        <InputRecord input={input} key={input.request.requestId} />
      ))}
      {item.state.errorText !== undefined ? (
        <ErrorText text={item.state.errorText} />
      ) : typeof item.state.output === "string" ? (
        <div className="text-[13px] text-foreground/80">
          <MessageResponse>{item.state.output}</MessageResponse>
        </div>
      ) : item.state.output !== undefined ? (
        <Payload label="reply" value={item.state.output} />
      ) : null}
    </div>
  );
}

function CallMessage({ text }: { readonly text: string }) {
  return (
    <p className="line-clamp-2 text-[12px] text-muted-foreground">
      <span className="font-mono">message</span> {text}
    </p>
  );
}

function InputRecord({ input }: { readonly input: ConversationInput }) {
  const focusInput = useContext(FocusInputContext);
  const answer = inputAnswer(input);
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
      <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
        {input.request.kind === "tool-approval" ? "approval" : "question"}
      </span>
      <span className="min-w-0 truncate">{oneLine(input.request.prompt)}</span>
      {input.status === "open" ? (
        <button
          className="shrink-0 font-medium text-amber-700 hover:underline dark:text-amber-500"
          onClick={() => focusInput(input.request.requestId)}
          type="button"
        >
          Answer
        </button>
      ) : (
        <Answer text={answer} />
      )}
    </div>
  );
}

function Answer({ text }: { readonly text: string | undefined }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-foreground">
      <ArrowRightIcon className="size-3 text-muted-foreground" />
      {text ?? "answered"}
    </span>
  );
}

function Payload({ label, value }: { readonly label: string; readonly value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="space-y-1">
      <p className="font-mono text-[11px] text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4">
        {formatJson(value)}
      </pre>
    </div>
  );
}

function ErrorText({ text }: { readonly text: string }) {
  return <p className="text-[13px] text-destructive">{text}</p>;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function StatusIcon({ status }: { readonly status: ActivityStatus }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "working":
      return <CircleDashedIcon className={cn(className, "text-muted-foreground")} />;
    case "needs-you":
      return <CircleDotIcon className={cn(className, "text-amber-600 dark:text-amber-500")} />;
    case "done":
      return <CheckIcon className={cn(className, "text-muted-foreground")} />;
    case "failed":
      return <XIcon className={cn(className, "text-destructive")} />;
    case "denied":
      return <BanIcon className={cn(className, "text-muted-foreground")} />;
    case "cancelled":
    case "interrupted":
      return <CircleSlashIcon className={cn(className, "text-muted-foreground")} />;
  }
}

function StatusText({ status }: { readonly status: ActivityStatus }): ReactNode {
  switch (status) {
    case "working":
      return (
        <Shimmer as="span" duration={1}>
          working
        </Shimmer>
      );
    case "needs-you":
      return <span className="text-amber-700 dark:text-amber-500">needs you</span>;
    case "failed":
      return <span className="text-destructive">failed</span>;
    case "denied":
      return <span>denied</span>;
    case "cancelled":
      return <span>cancelled</span>;
    case "interrupted":
      return <span>interrupted</span>;
    case "done":
      return null;
  }
}

export function Elapsed({
  live,
  since,
  times,
}: {
  readonly live: boolean;
  readonly since?: string;
  readonly times?: CallTimes;
}) {
  const now = useNow(live);
  const start = Date.parse(since ?? times?.startedAt ?? "");
  if (Number.isNaN(start)) return null;
  const end = live ? now : Date.parse(times?.settledAt ?? "");
  if (Number.isNaN(end)) return null;
  const text = formatDuration(end - start);
  return text.length === 0 ? null : <span className="tabular-nums">{text}</span>;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [active]);
  return now;
}
