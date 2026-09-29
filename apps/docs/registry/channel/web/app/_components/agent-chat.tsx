"use client";

import type { UserContent } from "ai";
import { useEveAgent } from "eve/react";
import { CircleAlertIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationTopFade,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputButton,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WEB_CHAT_AGENT } from "@/app/eve-agent";
import { FocusInputContext } from "./activity";
import { AssistantTurn, UserMessage } from "./agent-message";
import { dockItems, streamFacts, viewContext } from "./conversation-view";
import { InputDock } from "./input-dock";

const DEFAULT_AGENT_NAME = "eve-agent";
const AGENT_NAME = WEB_CHAT_AGENT ?? DEFAULT_AGENT_NAME;

export function AgentChat({
  sessionId,
  sessionless = false,
}: {
  readonly sessionId?: string;
  readonly sessionless?: boolean;
}) {
  const [cancellationError, setCancellationError] = useState<string>();
  const [hasInputText, setHasInputText] = useState(false);
  const [dockFocus, setDockFocus] = useState<string>();
  const agent = useEveAgent({
    agent: WEB_CHAT_AGENT,
    followSubagents: true,
    initialSession:
      sessionId === undefined
        ? undefined
        : {
            sessionId,
            streamIndex: 0,
          },
    resume: sessionId !== undefined,
    onSessionChange(session) {
      if (sessionId === undefined && session !== undefined) {
        // Next patches window.history to navigate, which would detach the active stream.
        History.prototype.replaceState.call(
          window.history,
          window.history.state,
          "",
          `/s/${encodeURIComponent(session.sessionId)}`,
        );
      }
    },
  });

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isResuming = agent.status === "resuming";
  const conversation = agent.data;
  const isEmpty = conversation.messages.length === 0;
  const facts = useMemo(() => streamFacts(agent.events), [agent.events]);
  const context = useMemo(
    () => viewContext(conversation, facts, isBusy),
    [conversation, facts, isBusy],
  );
  const dock = useMemo(() => dockItems(context), [context]);
  const lastMessage = conversation.messages.at(-1);
  const lastAssistantId = conversation.messages.findLast(
    (message) => message.role === "assistant",
  )?.id;
  // Before the turn's first event, nothing else says the agent is working.
  const showPendingThinking = isBusy && lastMessage?.role !== "assistant";
  const errorMessage =
    cancellationError ??
    agent.error?.message ??
    (isBusy ? undefined : facts.sessionFailure?.message);
  const hasConversationContent = sessionless || !isEmpty || errorMessage !== undefined;
  const showConversationLayout = isResuming || hasConversationContent;
  const activeSessionId = sessionId ?? agent.session?.sessionId;

  // Messages sent into a running turn render at the point they arrived, inside that turn.
  const steered = useMemo(() => {
    const assistantTurns = new Set(
      conversation.messages.flatMap((message) =>
        message.role === "assistant" && message.metadata?.turnId !== undefined
          ? [message.metadata.turnId]
          : [],
      ),
    );
    const byId = new Map<string, (typeof conversation.messages)[number]>();
    for (const message of conversation.messages) {
      const turnId = message.metadata?.turnId;
      if (
        message.role === "user" &&
        turnId !== undefined &&
        assistantTurns.has(turnId) &&
        facts.steeredMessageIds.has(message.id)
      ) {
        byId.set(message.id, message);
      }
    }
    return byId;
  }, [conversation, facts]);

  const focusInput = useCallback((requestId: string) => {
    setDockFocus(`input:${requestId}`);
  }, []);

  const bottomRef = useRef<HTMLDivElement>(null);
  const [bottomHeight, setBottomHeight] = useState(0);
  useEffect(() => {
    const element = bottomRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setBottomHeight(element.offsetHeight));
    observer.observe(element);
    setBottomHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [showConversationLayout]);

  const requestCancellation = () => {
    setCancellationError(undefined);
    void agent.cancel().catch((error: unknown) => {
      setCancellationError(toErrorMessage(error));
    });
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isResuming) return;

    setHasInputText(false);
    setCancellationError(undefined);
    const options = isBusy ? { turnPolicy: "steer" as const } : undefined;

    if (message.files.length === 0) {
      await agent.send(text, options);
      return;
    }

    const parts: UserContent = [];
    if (text.length > 0) {
      parts.push({ text, type: "text" });
    }
    for (const file of message.files) {
      parts.push({
        data: file.url,
        filename: file.filename,
        mediaType: file.mediaType,
        type: "file",
      });
    }

    await agent.send(parts, options);
  };

  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea
        disabled={isResuming}
        onChange={(event) => setHasInputText(event.currentTarget.value.trim().length > 0)}
        placeholder="Send a message…"
      />
      <ComposerAction
        hasInputText={hasInputText}
        isBusy={isBusy}
        isResuming={isResuming}
        onCancel={requestCancellation}
      />
    </PromptInput>
  );

  return (
    <FocusInputContext.Provider value={focusInput}>
      <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        {showConversationLayout ? (
          <ChatHeader canStartNewChat={activeSessionId !== undefined} />
        ) : null}

        {showConversationLayout ? (
          <Conversation
            className="min-h-0 flex-1"
            initial={sessionId === undefined ? undefined : false}
            resize={activeSessionId === undefined ? "smooth" : "instant"}
            scrollRestorationKey={
              isEmpty || activeSessionId === undefined
                ? undefined
                : `eve:web-chat-scroll:${activeSessionId}`
            }
          >
            <ConversationTopFade className="top-14" />
            <ConversationContent
              className="mx-auto w-full max-w-3xl gap-6 px-4 pt-20 sm:px-6"
              style={{ paddingBottom: Math.max(144, bottomHeight + 32) }}
            >
              {conversation.messages.map((message) =>
                message.role === "user" ? (
                  steered.has(message.id) ? null : (
                    <UserMessage key={message.id} message={message} />
                  )
                ) : (
                  <AssistantTurn
                    context={context}
                    isLastTurn={message.id === lastAssistantId}
                    key={message.id}
                    message={message}
                    steered={steered}
                  />
                ),
              )}
              {showPendingThinking ? <PendingThinking /> : null}
              {errorMessage ? <ErrorMessage message={errorMessage} /> : null}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        ) : null}

        <div
          className={cn(
            "mx-auto w-full px-4 sm:px-6",
            showConversationLayout
              ? "fixed bottom-0 left-1/2 z-20 max-w-3xl -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-6"
              : "flex max-w-xl flex-1 flex-col items-center justify-center gap-8 pb-[10vh]",
          )}
        >
          {showConversationLayout ? null : (
            <div className="flex flex-col items-center gap-3 text-center">
              <h1 className="font-medium text-5xl tracking-tighter">{AGENT_NAME}</h1>
            </div>
          )}
          <div className="w-full" ref={bottomRef}>
            <InputDock
              canRespond={!isResuming}
              focusKey={dockFocus}
              items={dock}
              onFocusKeyChange={setDockFocus}
              onRespond={async (response) => {
                setCancellationError(undefined);
                await agent.respond([response]);
              }}
            />
            {composer}
          </div>
        </div>
      </main>
    </FocusInputContext.Provider>
  );
}

function ComposerAction({
  hasInputText,
  isBusy,
  isResuming,
  onCancel,
}: {
  readonly hasInputText: boolean;
  readonly isBusy: boolean;
  readonly isResuming: boolean;
  readonly onCancel: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const canSubmit = hasInputText || attachments.files.length > 0;

  if (!isBusy || canSubmit) {
    return <PromptInputSubmit disabled={isResuming} />;
  }

  return (
    <PromptInputButton
      aria-label="Stop"
      className="absolute right-2.5 bottom-2.5"
      onClick={onCancel}
      variant="outline"
    >
      <SquareIcon className="size-3 fill-current" />
    </PromptInputButton>
  );
}

function ErrorMessage({ message }: { readonly message: string }) {
  return (
    <p className="flex items-start gap-1.5 text-destructive text-sm" role="alert">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

function ChatHeader({ canStartNewChat }: { readonly canStartNewChat: boolean }) {
  return (
    <header className="pointer-events-none fixed top-0 right-0 left-0 z-20 h-14">
      <div className="relative mx-auto flex h-full w-full max-w-3xl items-center justify-center bg-background px-24">
        <span className="truncate text-muted-foreground text-sm">{AGENT_NAME}</span>
        {canStartNewChat ? (
          <Button
            aria-label="Start a new chat"
            className="pointer-events-auto fixed top-3 right-6 pr-4"
            onClick={() => window.location.assign("/s")}
            size="sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
            <span className="hidden font-normal text-sm sm:inline">New chat</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function PendingThinking() {
  return (
    <div aria-live="polite" className="text-muted-foreground text-sm">
      <Shimmer as="span" duration={1}>
        Thinking
      </Shimmer>
    </div>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to cancel the response.";
}
