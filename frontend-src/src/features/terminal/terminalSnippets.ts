import { useSyncExternalStore } from "react";

export type Snippet = { id: string; name: string; command: string };

const STORAGE_KEY = "rustshell.snippets.v2";
/** Pre-v2 storage held only user additions; the six starters were hardcoded. */
const LEGACY_KEY = "rustshell.snippets.custom";
const MAX_SNIPPETS = 100;

/** Seeded into the store on first run rather than kept as a separate immutable
 * list, so every chip on the toolbar is editable, reorderable and removable. */
export const defaultSnippetCommands = ["pwd", "ls -la", "df -h", "free -h", "ps aux | head", "whoami"];

export function createSnippetId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `snippet-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function buildDefaultSnippets(): Snippet[] {
  return defaultSnippetCommands.map((command) => ({ id: createSnippetId(), name: command, command }));
}

function isSnippet(value: unknown): value is Snippet {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Snippet;
  return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.command === "string";
}

function parseSnippets(raw: string | null): Snippet[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSnippet).slice(0, MAX_SNIPPETS) : null;
  } catch {
    return null;
  }
}

function readFromStorage(): Snippet[] {
  const stored = parseSnippets(window.localStorage.getItem(STORAGE_KEY));
  if (stored) return stored;

  // First run on v2: fold whatever the user had already added into the starter
  // set so nothing they wrote disappears behind the new storage key.
  const legacy = parseSnippets(window.localStorage.getItem(LEGACY_KEY)) ?? [];
  const migrated = [...buildDefaultSnippets(), ...legacy].slice(0, MAX_SNIPPETS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Quota or private-mode failures just mean the seed is not persisted yet.
  }
  return migrated;
}

/** The snapshot has to stay referentially stable between writes, otherwise
 * useSyncExternalStore re-renders on every read. */
let snapshot: Snippet[] | null = null;
const listeners = new Set<() => void>();
let storageBound = false;

function emit() {
  listeners.forEach((listener) => listener());
}

export function getSnippets(): Snippet[] {
  if (!snapshot) {
    try {
      snapshot = readFromStorage();
    } catch {
      snapshot = buildDefaultSnippets();
    }
  }
  return snapshot;
}

export function setSnippets(next: Snippet[]) {
  snapshot = next.slice(0, MAX_SNIPPETS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Keep the in-memory value; persistence is best-effort.
  }
  emit();
}

function subscribe(listener: () => void) {
  if (!storageBound) {
    storageBound = true;
    // The file manager runs in a second webview on the same origin, so a write
    // over there has to land here too.
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      snapshot = parseSnippets(window.localStorage.getItem(STORAGE_KEY)) ?? buildDefaultSnippets();
      emit();
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every toolbar, the broadcast bar and the command palette read through this,
 * so an edit in one pane is visible in all of them on the same frame. */
export function useSnippets(): Snippet[] {
  return useSyncExternalStore(subscribe, getSnippets, getSnippets);
}

export function addSnippet(name: string, command: string): boolean {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return false;
  const current = getSnippets();
  if (current.length >= MAX_SNIPPETS) return false;
  setSnippets([...current, { id: createSnippetId(), name: name.trim() || trimmedCommand, command: trimmedCommand }]);
  return true;
}

export function updateSnippet(id: string, name: string, command: string): boolean {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return false;
  setSnippets(
    getSnippets().map((snippet) =>
      snippet.id === id ? { ...snippet, name: name.trim() || trimmedCommand, command: trimmedCommand } : snippet
    )
  );
  return true;
}

export function removeSnippet(id: string) {
  setSnippets(getSnippets().filter((snippet) => snippet.id !== id));
}

/** Moves a snippet by `delta` positions, clamped to the ends of the list. */
export function moveSnippet(id: string, delta: number) {
  const current = getSnippets();
  const from = current.findIndex((snippet) => snippet.id === id);
  if (from < 0) return;
  const to = Math.min(current.length - 1, Math.max(0, from + delta));
  if (to === from) return;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  setSnippets(next);
}

export function restoreDefaultSnippets() {
  setSnippets(buildDefaultSnippets());
}
