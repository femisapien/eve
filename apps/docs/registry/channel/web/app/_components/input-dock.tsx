"use client";

import type { ConversationInput } from "eve/react";
import {
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import {
  Question,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  type QuestionResponse,
  QuestionSubmit,
  type QuestionValue,
} from "@/components/ai-elements/question";
import { Button } from "@/components/ui/button";
import { type DockItem, describeInput, formatJson } from "./conversation-view";

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

/**
 * Everything that waits on the person, from any depth of the agent tree, in the order it
 * arrived. Answers send one at a time, so an agent waiting on one resumes without the rest.
 */
export function InputDock({
  canRespond,
  focusKey,
  items,
  onFocusKeyChange,
  onRespond,
}: {
  readonly canRespond: boolean;
  readonly focusKey: string | undefined;
  readonly items: readonly DockItem[];
  readonly onFocusKeyChange: (key: string) => void;
  readonly onRespond: (response: AgentInputResponse) => Promise<void>;
}) {
  if (items.length === 0) return null;
  const focused = items.findIndex((item) => item.key === focusKey);
  const index = focused === -1 ? 0 : focused;
  const item = items[index] as DockItem;
  const step = (delta: number) => {
    const next = items[(index + delta + items.length) % items.length];
    if (next !== undefined) onFocusKeyChange(next.key);
  };

  return (
    <section
      aria-label="Needs your input"
      className="mb-2 rounded-2xl border bg-background shadow-sm"
    >
      <header className="flex min-w-0 items-center gap-2 px-4 pt-3 text-xs">
        <CircleDotIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <span className="shrink-0 font-medium">{dockKindLabel(item)}</span>
        <DockRequester item={item} />
        {items.length > 1 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
            <span className="tabular-nums">
              {index + 1} of {items.length}
            </span>
            <Button
              aria-label="Previous request"
              className="size-6"
              onClick={() => step(-1)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
            <Button
              aria-label="Next request"
              className="size-6"
              onClick={() => step(1)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronRightIcon className="size-3.5" />
            </Button>
          </span>
        ) : null}
      </header>
      <div className="max-h-[45dvh] overflow-y-auto px-4 pt-2 pb-4">
        {item.kind === "auth" ? (
          <SignInBody item={item} />
        ) : (
          <InputBody
            canRespond={canRespond}
            input={item.input}
            key={item.key}
            onRespond={onRespond}
          />
        )}
      </div>
    </section>
  );
}

function dockKindLabel(item: DockItem): string {
  if (item.kind === "auth") return "sign-in";
  switch (item.input.request.kind) {
    case "question":
      return "question";
    case "tool-approval":
      return "approval";
    case "session-limit":
      return "session limit";
  }
}

function DockRequester({ item }: { readonly item: DockItem }) {
  const path =
    item.kind === "auth"
      ? [item.part.displayName]
      : item.input.request.kind === "tool-approval"
        ? [...item.requester, item.input.request.action.toolName]
        : item.requester;
  if (path.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
      <span aria-hidden="true">·</span>
      {path.map((segment, index) => (
        <Fragment key={`${segment}:${index}`}>
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          <code className="font-mono text-[12px]">{segment}</code>
        </Fragment>
      ))}
    </span>
  );
}

function InputBody({
  canRespond,
  input,
  onRespond,
}: {
  readonly canRespond: boolean;
  readonly input: ConversationInput;
  readonly onRespond: (response: AgentInputResponse) => Promise<void>;
}) {
  const { request } = input;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = !canRespond || pending;

  const send = async (response: Omit<AgentInputResponse, "requestId">) => {
    setPending(true);
    setError(undefined);
    try {
      await onRespond({ ...response, requestId: request.requestId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send the answer.");
      setPending(false);
    }
  };

  if (request.kind === "question" && request.display !== "confirmation") {
    return (
      <div className="space-y-2">
        <QuestionRequest disabled={disabled} onSend={send} request={request} />
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </div>
    );
  }

  const options = request.options ?? [];
  const approvalInput =
    request.kind === "tool-approval" ? describeInput(request.action.input) : undefined;

  return (
    <div className="space-y-3">
      <p className="font-medium text-sm leading-snug">{request.prompt}</p>
      {request.kind === "tool-approval" ? (
        <details className="group text-xs">
          <summary className="cursor-pointer list-none truncate font-mono text-muted-foreground hover:text-foreground">
            {approvalInput ?? "input"}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4">
            {formatJson(request.action.input)}
          </pre>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {options.map((option, index) => (
          <Button
            disabled={disabled}
            key={option.id}
            onClick={() => void send({ optionId: option.id })}
            size="sm"
            type="button"
            variant={optionVariant(options, index)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

/** A question from any depth, answered with an option or, when allowed, in the person's words. */
function QuestionRequest({
  disabled,
  onSend,
  request,
}: {
  readonly disabled: boolean;
  readonly onSend: (response: Omit<AgentInputResponse, "requestId">) => Promise<void>;
  readonly request: ConversationInput["request"];
}) {
  const options = request.options ?? [];
  const acceptsFreeform = request.allowFreeform === true || options.length === 0;
  const [value, setValue] = useState<QuestionValue>({ selectedValues: [], text: "" });

  return (
    <Question
      className="space-y-3 rounded-none border-0 bg-transparent p-0"
      disabled={disabled}
      onSubmit={({ selectedValues, text }: QuestionResponse) =>
        onSend({ optionId: selectedValues[0], text })
      }
      onValueChange={setValue}
      value={value}
    >
      <QuestionPrompt>{request.prompt}</QuestionPrompt>
      {options.length > 0 ? (
        <QuestionOptions aria-label={request.prompt} className="flex-col items-stretch">
          {options.map((option, index) => (
            <QuestionOption
              className="justify-start px-3 py-2 text-left"
              key={option.id}
              onClick={() => void onSend({ optionId: option.id })}
              value={option.id}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-foreground text-sm leading-tight">{option.label}</span>
                {option.description ? (
                  <span className="block text-muted-foreground text-xs leading-snug">
                    {option.description}
                  </span>
                ) : null}
              </span>
              <span aria-hidden="true" className="relative size-6 shrink-0">
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-foreground/8 text-muted-foreground text-xs transition-opacity group-hover/option:opacity-0 group-focus-visible/option:opacity-0">
                  {index + 1}
                </span>
                <ArrowRightIcon className="absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-[color,opacity] group-hover/option:text-foreground group-hover/option:opacity-100 group-focus-visible/option:opacity-100" />
              </span>
            </QuestionOption>
          ))}
        </QuestionOptions>
      ) : null}
      {acceptsFreeform ? (
        <div className="relative">
          <QuestionInput
            aria-label="Answer"
            className="min-h-14 pr-12"
            placeholder={options.length > 0 ? "Or type an answer…" : "Type an answer…"}
          />
          {value.text.trim().length > 0 ? (
            <QuestionSubmit
              aria-label="Send answer"
              className="absolute right-2 bottom-2"
              size="icon-sm"
            >
              <ArrowRightIcon />
            </QuestionSubmit>
          ) : null}
        </div>
      ) : null}
    </Question>
  );
}

/** The primary option, or the first when none is marked, is the filled button. */
function optionVariant(
  options: NonNullable<ConversationInput["request"]["options"]>,
  index: number,
): "default" | "outline" {
  const primary = options.findIndex((option) => option.style === "primary");
  return index === (primary === -1 ? 0 : primary) ? "default" : "outline";
}

function SignInBody({ item }: { readonly item: Extract<DockItem, { kind: "auth" }> }) {
  const { part } = item;
  const challenge = part.authorization;
  return (
    <div className="space-y-3">
      <p className="font-medium text-sm leading-snug">Connect {part.displayName}</p>
      <p className="text-muted-foreground text-sm">{part.description}</p>
      {challenge?.instructions && challenge.instructions !== part.description ? (
        <p className="text-muted-foreground text-sm">{challenge.instructions}</p>
      ) : null}
      {challenge?.userCode ? (
        <p className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Code</span>
          <code className="rounded-md bg-muted px-2 py-1 font-mono">{challenge.userCode}</code>
        </p>
      ) : null}
      {challenge?.url ? (
        <Button asChild size="sm">
          <a href={challenge.url} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-4" />
            Sign in with {part.displayName}
          </a>
        </Button>
      ) : null}
    </div>
  );
}
