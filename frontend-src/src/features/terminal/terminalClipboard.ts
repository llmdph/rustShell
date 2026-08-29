import type { Terminal } from "@xterm/xterm";

type TerminalClipboardHandle = {
  copySelection: () => Promise<boolean>;
  paste: () => Promise<boolean>;
};

const handles = new Map<string, TerminalClipboardHandle>();

export function registerTerminalClipboard(terminalId: string, handle: TerminalClipboardHandle) {
  handles.set(terminalId, handle);
  return () => {
    if (handles.get(terminalId) === handle) handles.delete(terminalId);
  };
}

export function copyTerminalSelection(terminalId: string) {
  return handles.get(terminalId)?.copySelection() ?? Promise.resolve(false);
}

export function pasteIntoTerminal(terminalId: string) {
  return handles.get(terminalId)?.paste() ?? Promise.resolve(false);
}

export async function writeTerminalSelection(term: Terminal) {
  const text = term.getSelection();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function pasteClipboardIntoTerminal(term: Terminal) {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return false;
  }
  if (!text) return false;
  // xterm normalizes line endings and wraps bracketed-paste when the shell asked.
  term.paste(text);
  term.focus();
  return true;
}
