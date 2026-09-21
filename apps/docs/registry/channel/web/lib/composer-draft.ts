import { EditorState, type Extension } from "@codemirror/state";
import { history, historyField, isolateHistory } from "@codemirror/commands";

export const draftHistory = { history: historyField };
export const draftExtensions = () => [history({ minDepth: 100 })];
export interface DraftRecord {
  version: 1;
  updatedAt: number;
  editor: ReturnType<EditorState["toJSON"]>;
  filesKey?: string;
}
export interface DraftStorage {
  load(scope: string): DraftRecord | undefined;
  save(scope: string, record: DraftRecord): boolean;
}
const prefix = "eve:web:composer:v1:";
export function draftScope(owner: string, session?: string) {
  return `${encodeURIComponent(owner)}:${encodeURIComponent(session ?? "new")}`;
}

/** Each document writes its own branch; sessionStorage remembers this tab's branch on reload. */
export function createDraftStorage(disk: Storage, tab: Storage, writer: string): DraftStorage {
  const memory = new Map<string, DraftRecord>();
  return {
    load(scope) {
      if (memory.has(scope)) return memory.get(scope);
      try {
        const base = `${prefix}${scope}:`;
        const own = disk.getItem(base + writer);
        const previousKey = tab.getItem(base);
        const previous = previousKey && disk.getItem(previousKey);
        const preferred = parseDraft(own ?? previous ?? null);
        if (preferred) return preferred;
        let latest: DraftRecord | undefined;
        for (let i = 0; i < disk.length; i++) {
          const key = disk.key(i);
          if (!key?.startsWith(base)) continue;
          const record = parseDraft(disk.getItem(key));
          if (record && (!latest || record.updatedAt > latest.updatedAt)) latest = record;
        }
        return latest;
      } catch {
        return undefined;
      }
    },
    save(scope, record) {
      memory.set(scope, record);
      try {
        const base = `${prefix}${scope}:`;
        const key = base + writer;
        disk.setItem(key, JSON.stringify(record));
        tab.setItem(base, key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
export function parseDraft(raw: string | null): DraftRecord | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      !Number.isFinite(value.updatedAt) ||
      typeof value.editor?.doc !== "string"
    )
      return;
    if (value.filesKey !== undefined && typeof value.filesKey !== "string") return;
    return value;
  } catch {
    return;
  }
}
export function restoreDraft(record?: DraftRecord, extensions: Extension = []): EditorState {
  const config = { extensions: [draftExtensions(), extensions] };
  if (record) {
    try {
      return EditorState.fromJSON(record.editor, config, draftHistory);
    } catch {
      return EditorState.create({ ...config, doc: record.editor.doc });
    }
  }
  return EditorState.create(config);
}
export interface DraftSubmission {
  readonly state: EditorState;
  readonly revision: number;
}
export function createDraftDocument(
  storage: DraftStorage,
  initialScope: string,
  extensions: Extension = [],
) {
  let scope = initialScope;
  const record = storage.load(scope);
  let state = restoreDraft(record, extensions);
  let revision = 0;
  let filesKey = record?.filesKey;
  let filesDirty = false;
  let dirty = false;
  return {
    get state() {
      return state;
    },
    get filesKey() {
      return filesKey;
    },
    update(next: EditorState) {
      if (next.doc !== state.doc) revision++;
      state = next;
      dirty = true;
    },
    capture(): DraftSubmission {
      return { state, revision };
    },
    acknowledge(submission: DraftSubmission) {
      // A response must never erase edits made after the user pressed Send.
      if (
        revision !== submission.revision ||
        state.doc.toString() !== submission.state.doc.toString()
      )
        return;
      const transaction = state.update({
        changes: { from: 0, to: state.doc.length, insert: "" },
        selection: { anchor: 0 },
        annotations: isolateHistory.of("full"),
      });
      state = transaction.state;
      revision++;
      dirty = true;
      return transaction;
    },
    setFiles(key?: string, preserveLatestEditor = false) {
      if (preserveLatestEditor) {
        const latest = storage.load(scope);
        if (latest?.filesKey !== filesKey) return;
        state = restoreDraft(latest, extensions);
      }
      filesKey = key;
      filesDirty = true;
      dirty = true;
    },
    move(nextScope: string) {
      if (nextScope === scope) return true;
      const previousScope = scope;
      scope = nextScope;
      filesDirty = true;
      dirty = true;
      // Persist the destination before clearing the old slot, so a quota failure
      // still leaves the original draft recoverable on disk.
      if (!this.flush()) return false;
      return storage.save(previousScope, {
        version: 1,
        updatedAt: Date.now(),
        editor: EditorState.create({ extensions: draftExtensions() }).toJSON(draftHistory),
      });
    },
    flush() {
      if (!dirty) return true;
      if (!filesDirty) filesKey = storage.load(scope)?.filesKey;
      const saved = storage.save(scope, {
        version: 1,
        updatedAt: Date.now(),
        editor: state.toJSON(draftHistory),
        filesKey,
      });
      if (saved) {
        dirty = false;
        filesDirty = false;
      }
      return saved;
    },
  };
}
export type DraftDocument = ReturnType<typeof createDraftDocument>;
