import { useCallback } from "react";

type CopyWithFallbackOptions = {
  title: string;
  text: string;
  onCopied?: () => void;
};

type ShowTextDialog = (title: string, text: string) => Promise<string | null>;

export function useClipboardFallback(showTextDialog: ShowTextDialog) {
  return useCallback(
    async ({ title, text, onCopied }: CopyWithFallbackOptions) => {
      try {
        await navigator.clipboard.writeText(text);
        onCopied?.();
        return true;
      } catch {
        await showTextDialog(title, text);
        return false;
      }
    },
    [showTextDialog]
  );
}
