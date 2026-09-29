"use client";

import type { EveMessage, EveMessagePart } from "eve/react";
import { CircleSlashIcon, ExternalLinkIcon, FileIcon, ImageIcon, XIcon } from "lucide-react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { ActivityDisclosure, Elapsed } from "./activity";
import {
  formatDuration,
  itemStatus,
  type TurnBreak,
  type TurnFooter,
  turnFooter,
  turnLayout,
  type ViewContext,
} from "./conversation-view";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

export function UserMessage({ message }: { readonly message: EveMessage }) {
  return (
    <Message data-optimistic={message.metadata?.optimistic ? "true" : undefined} from="user">
      <MessageContent>
        {message.parts.map((part, index) =>
          part.type === "text" ? (
            <MessageResponse key={`text:${part.id ?? index}`}>{part.text}</MessageResponse>
          ) : part.type === "file" ? (
            <AttachmentPart key={`file:${index}`} part={part} />
          ) : null,
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * One assistant turn: each stretch of prose, then one folded activity row for the work behind
 * it. Waits and messages sent into the turn split it, and the turn ends with its live status or
 * its outcome.
 */
export function AssistantTurn({
  context,
  isLastTurn,
  message,
  steered,
}: {
  readonly context: ViewContext;
  readonly isLastTurn: boolean;
  readonly message: EveMessage;
  /** User messages sent into this turn while it ran, by message ID. */
  readonly steered: ReadonlyMap<string, EveMessage>;
}) {
  const entries = turnLayout(message, context);
  const turnId = message.metadata?.turnId;
  const lastText = findLastStreamingText(entries);
  const hasContent = entries.some((entry) => entry.kind === "segment");
  const footer = visibleFooter(turnFooter(turnId, context), entries);

  return (
    <div className="flex flex-col gap-4">
      {entries.map((entry) => {
        if (entry.kind === "break") {
          if (entry.brk.kind === "wait") return <WaitDivider brk={entry.brk} key={entry.key} />;
          const steeredMessage =
            entry.brk.messageId === undefined ? undefined : steered.get(entry.brk.messageId);
          return steeredMessage === undefined ? null : (
            <UserMessage key={entry.key} message={steeredMessage} />
          );
        }
        const { segment } = entry;
        return (
          <Message from="assistant" key={segment.key}>
            <MessageContent className="gap-3">
              {segment.texts.map((text) => (
                <MessageResponse
                  caret="block"
                  isAnimating={isLastTurn && text.streaming && text.key === lastText}
                  key={text.key}
                >
                  {text.text}
                </MessageResponse>
              ))}
              {segment.activity.length > 0 ? <ActivityDisclosure items={segment.activity} /> : null}
            </MessageContent>
          </Message>
        );
      })}
      {footer === undefined ? null : <FooterLine footer={footer} hasContent={hasContent} />}
    </div>
  );
}

/** A live activity row or streaming prose already says the turn is working. */
function visibleFooter(
  footer: TurnFooter | undefined,
  entries: ReturnType<typeof turnLayout>,
): TurnFooter | undefined {
  if (footer?.kind !== "working") return footer;
  const last = entries.at(-1);
  if (last?.kind !== "segment") return footer;
  const { activity, texts } = last.segment;
  const streaming = texts.at(-1)?.streaming === true && activity.length === 0;
  const live = activity.some((item) => itemStatus(item) === "working");
  return streaming || live ? undefined : footer;
}

function findLastStreamingText(entries: ReturnType<typeof turnLayout>): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "segment") continue;
    const text = entry.segment.texts.at(-1);
    if (text !== undefined) return text.key;
  }
  return undefined;
}

function WaitDivider({ brk }: { readonly brk: TurnBreak }) {
  const start = Date.parse(brk.at ?? "");
  const end = Date.parse(brk.resumedAt ?? "");
  const waited = Number.isNaN(start) || Number.isNaN(end) ? "" : formatDuration(end - start);
  return (
    <div className="flex items-center gap-3 text-muted-foreground text-xs" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span>{waited ? `waited ${waited}` : "waited"}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function FooterLine({
  footer,
  hasContent,
}: {
  readonly footer: TurnFooter;
  readonly hasContent: boolean;
}) {
  switch (footer.kind) {
    case "working":
      return (
        <div aria-live="polite" className="text-muted-foreground text-sm">
          <Shimmer as="span" duration={1}>
            {hasContent ? "Working…" : "Thinking"}
          </Shimmer>
        </div>
      );
    case "waiting": {
      const needsYou = footer.on.some((entry) => entry.needsYou);
      return (
        <div
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-sm"
        >
          {needsYou ? (
            <span>Waiting on</span>
          ) : (
            <Shimmer as="span" duration={1.5}>
              {footer.on.length > 0 ? "Waiting on" : "Waiting"}
            </Shimmer>
          )}
          {footer.on.map((entry, index) => (
            <span
              className={cn(entry.needsYou && "text-amber-700 dark:text-amber-500")}
              key={entry.name}
            >
              {entry.name === "you" ? (
                "you"
              ) : (
                <code className="font-mono text-[12px]">{entry.name}</code>
              )}
              {index < footer.on.length - 1 ? "," : ""}
            </span>
          ))}
          {footer.since ? (
            <span className="text-xs">
              · <Elapsed live since={footer.since} />
            </span>
          ) : null}
        </div>
      );
    }
    case "cancelled":
      return (
        <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
          <CircleSlashIcon className="size-3.5" />
          Cancelled
        </p>
      );
    case "failed":
      return (
        <p className="flex items-start gap-1.5 text-destructive text-sm" role="alert">
          <XIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{footer.message}</span>
        </p>
      );
  }
}

function AttachmentPart({ part }: { readonly part: EveFilePart }) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const body = (
    <span className="flex max-w-sm items-center gap-3 rounded-md border bg-background/60 p-2 text-sm">
      {isImage ? (
        <img alt={label} className="size-12 shrink-0 rounded-sm object-cover" src={part.url} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null}
      </span>
      {part.url ? <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
    </span>
  );

  return part.url ? (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  ) : (
    body
  );
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
