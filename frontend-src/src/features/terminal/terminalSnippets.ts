export const terminalSnippets = ["pwd", "ls -la", "df -h", "free -h", "ps aux | head", "whoami"];

export type CustomSnippet = { id: string; name: string; command: string };

const STORAGE_KEY = "rustshell.snippets.custom";

export function loadCustomSnippets(): CustomSnippet[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is CustomSnippet =>
          !!item &&
          typeof item === "object" &&
          typeof (item as CustomSnippet).id === "string" &&
          typeof (item as CustomSnippet).command === "string" &&
          typeof (item as CustomSnippet).name === "string"
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function saveCustomSnippets(snippets: CustomSnippet[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
  } catch {
    // ignore quota/serialization errors
  }
}
