"use client";

import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, historyKeymap, undo, redo } from "@codemirror/commands";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import {
  createDraftDocument,
  createDraftStorage,
  draftScope,
  type DraftStorage,
} from "@/lib/composer-draft";
import { readDraftFiles, writeDraftFiles, type DraftFile } from "@/lib/draft-files";

export interface ComposerEditorHandle {
  capture(): (() => void) | undefined;
  move(sessionId: string): void;
}
let storage: DraftStorage | undefined;
function browserStorage() {
  if (!storage) {
    // Access to browser storage itself can throw in restricted browser contexts.
    const unavailable: Storage = {
      length: 0,
      key() {
        return null;
      },
      clear() {
        throw new Error("Storage unavailable");
      },
      removeItem() {
        throw new Error("Storage unavailable");
      },
      getItem() {
        throw new Error("Storage unavailable");
      },
      setItem() {
        throw new Error("Storage unavailable");
      },
    };
    let disk = unavailable,
      tab = unavailable;
    try {
      disk = localStorage;
      tab = sessionStorage;
    } catch {
      /* Keep this page's in-memory draft. */
    }
    storage = createDraftStorage(disk, tab, crypto.randomUUID());
  }
  return storage;
}
const appearance = EditorView.theme({
  "&": { fontSize: "14px", width: "100%", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "24px",
    maxHeight: "192px",
    overflow: "auto",
  },
  ".cm-content": { padding: "0", minHeight: "24px", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent)",
  },
});

export function PersistentComposerEditor({
  owner,
  sessionId,
  disabled,
  placeholder: hint,
  onTextChange,
  editorRef,
}: {
  readonly owner: string;
  readonly sessionId?: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onTextChange: (hasText: boolean) => void;
  readonly editorRef: Ref<ComposerEditorHandle | null>;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const attachments = usePromptInputAttachments();
  const latest = useRef({ disabled, onTextChange, attachments });
  latest.current = { disabled, onTextChange, attachments };
  const [warning, setWarning] = useState(false);
  const [filesReady, setFilesReady] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const controls = useRef<{
    configure(disabled: boolean, hint: string): void;
    persistFiles(): void;
    restoreFiles(): void;
  } | null>(null);
  const initialSession = useRef(sessionId);

  useLayoutEffect(() => {
    if (!mount.current) return;
    let mounted = true;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsavedText = false,
      unsavedFiles = false;
    let fileVersion = 0;
    let fileSignature = "";
    let fileRecords: Promise<DraftFile[]> = Promise.resolve([]);
    const mode = new Compartment();
    const label = new Compartment();
    const report = () => {
      if (mounted) setWarning(unsavedText || unsavedFiles);
    };
    const draft = createDraftDocument(browserStorage(), draftScope(owner, initialSession.current), [
      appearance,
      EditorView.lineWrapping,
      mode.of([
        EditorState.readOnly.of(latest.current.disabled),
        EditorView.editable.of(!latest.current.disabled),
      ]),
      label.of(placeholder(hint)),
      EditorView.contentAttributes.of({
        "aria-label": "Message",
        role: "textbox",
        spellcheck: "true",
        "aria-multiline": "true",
      }),
      keymap.of([
        {
          key: "Enter",
          run(view) {
            if (view.composing || latest.current.disabled) return false;
            mount.current?.closest("form")?.requestSubmit();
            return true;
          },
        },
        { key: "Ctrl-z", run: undo },
        { key: "Ctrl-Shift-z", run: redo },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({
        paste(event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length || latest.current.disabled) return false;
          latest.current.attachments.add(files);
          return true;
        },
        blur() {
          flush();
        },
      }),
      EditorView.updateListener.of((update) => {
        draft.update(update.state);
        if (hidden.current) hidden.current.value = update.state.doc.toString();
        if (update.docChanged)
          latest.current.onTextChange(update.state.doc.toString().trim().length > 0);
        clearTimeout(timer);
        timer = setTimeout(flush, 150);
      }),
    ]);
    function flush() {
      clearTimeout(timer);
      unsavedText = !draft.flush();
      report();
    }
    const view = new EditorView({ state: draft.state, parent: mount.current });
    if (hidden.current) hidden.current.value = view.state.doc.toString();
    latest.current.onTextChange(view.state.doc.toString().trim().length > 0);

    function saveFiles(records: Promise<DraftFile[]>) {
      const version = ++fileVersion;
      fileRecords = records;
      unsavedFiles = true;
      void records
        .then(writeDraftFiles)
        .then((key) => {
          if (version !== fileVersion) return;
          draft.setFiles(key, !mounted);
          unsavedFiles = false;
          flush();
        })
        .catch(() => {
          if (version === fileVersion) {
            unsavedFiles = true;
            report();
          }
        });
    }
    function persistFiles() {
      ready = true;
      const files = latest.current.attachments.files;
      const signature = files.map((file) => file.id).join(",");
      if (signature === fileSignature) return;
      fileSignature = signature;
      saveFiles(
        Promise.all(
          files.map(async (file) => ({
            id: file.id,
            file: new File([await (await fetch(file.url)).blob()], file.filename ?? "attachment", {
              type: file.mediaType,
            }),
          })),
        ),
      );
    }
    function restoreFiles() {
      setRestoreFailed(false);
      void readDraftFiles(draft.filesKey)
        .then((files) => {
          if (!mounted) return;
          latest.current.attachments.add(files.map(({ file }) => file));
          unsavedFiles = false;
          report();
          setFilesReady(true);
        })
        .catch(() => {
          unsavedFiles = true;
          if (mounted) setRestoreFailed(true);
          report();
        });
    }
    restoreFiles();

    const handle: ComposerEditorHandle = {
      capture() {
        if (!ready) return;
        persistFiles();
        const submission = draft.capture();
        const ids = new Set(latest.current.attachments.files.map((file) => file.id));
        return () => {
          const transaction = draft.acknowledge(submission);
          if (transaction && mounted) view.dispatch(transaction);
          if (mounted) {
            for (const id of ids) latest.current.attachments.remove(id);
          } else if (ids.size) {
            // Acknowledgments may arrive after navigating to another chat.
            saveFiles(fileRecords.then((files) => files.filter((file) => !ids.has(file.id))));
          }
          flush();
        };
      },
      move(id) {
        unsavedText = !draft.move(draftScope(owner, id));
        report();
      },
    };
    if (typeof editorRef === "function") editorRef(handle);
    else if (editorRef) editorRef.current = handle;
    controls.current = {
      configure(isDisabled, text) {
        view.dispatch({
          effects: [
            mode.reconfigure([
              EditorState.readOnly.of(isDisabled),
              EditorView.editable.of(!isDisabled),
            ]),
            label.reconfigure(placeholder(text)),
          ],
        });
        view.contentDOM.setAttribute("aria-disabled", String(isDisabled));
      },
      persistFiles,
      restoreFiles,
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (unsavedText || unsavedFiles) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      flush();
      mounted = false;
      view.destroy();
      controls.current = null;
      if (typeof editorRef === "function") editorRef(null);
      else if (editorRef) editorRef.current = null;
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
    // A document belongs to this owner for the mounted conversation's lifetime.
    // Session assignment moves it explicitly without resetting the editor history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, editorRef]);

  useLayoutEffect(() => {
    controls.current?.configure(disabled || !filesReady, hint);
  }, [disabled, hint, filesReady]);
  useLayoutEffect(() => {
    if (filesReady) controls.current?.persistFiles();
  }, [attachments.files, filesReady]);

  return (
    <div className="w-full min-w-0 px-4 pt-4">
      <input ref={hidden} name="message" type="hidden" />
      <div ref={mount} className="min-h-6 w-full" />
      {attachments.files.length ? (
        <div className="flex flex-wrap gap-1 pt-2">
          {attachments.files.map((file) => (
            <Button
              variant="secondary"
              size="sm"
              key={file.id}
              type="button"
              className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${file.filename ?? "attachment"}`}
              onClick={() => attachments.remove(file.id)}
            >
              {file.filename ?? "Attachment"} ×
            </Button>
          ))}
        </div>
      ) : null}
      {warning ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          {restoreFailed
            ? "Saved attachments could not be restored."
            : "Draft could not be saved on this device. Keep this tab open."}
          {restoreFailed ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 py-0 text-xs"
              onClick={() => controls.current?.restoreFiles()}
            >
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
