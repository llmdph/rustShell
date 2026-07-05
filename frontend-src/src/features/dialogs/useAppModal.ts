import { useCallback, useRef, useState } from "react";

import type { AppModalState } from "@/features/dialogs/AppDialogs";
import type { AppConfirmOptions, AppPromptOptions } from "@/features/dialogs/dialogTypes";

export function useAppModal() {
  const [appModal, setAppModal] = useState<AppModalState | null>(null);
  const appModalResolveRef = useRef<((value: string | boolean | null) => void) | null>(null);

  const resolveAppModal = useCallback((value: string | boolean | null) => {
    const resolve = appModalResolveRef.current;
    appModalResolveRef.current = null;
    setAppModal(null);
    resolve?.(value);
  }, []);

  const promptText = useCallback((title: string, options: AppPromptOptions = {}) => {
    return new Promise<string | null>((resolve) => {
      appModalResolveRef.current = (value) => resolve(typeof value === "string" ? value : null);
      setAppModal({
        kind: "prompt",
        title,
        message: options.message,
        value: options.defaultValue ?? "",
        placeholder: options.placeholder,
        multiline: options.multiline,
        readOnly: options.readOnly,
        confirmLabel: options.confirmLabel ?? "确定",
        cancelLabel: options.cancelLabel ?? "取消"
      });
    });
  }, []);

  const confirmAction = useCallback((title: string, options: AppConfirmOptions = {}) => {
    return new Promise<boolean>((resolve) => {
      appModalResolveRef.current = (value) => resolve(value === true);
      setAppModal({
        kind: "confirm",
        title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? "确定",
        cancelLabel: options.cancelLabel ?? "取消",
        danger: options.danger
      });
    });
  }, []);

  const showTextDialog = useCallback(
    (title: string, text: string) =>
      promptText(title, {
        defaultValue: text,
        multiline: true,
        readOnly: true,
        confirmLabel: "关闭",
        cancelLabel: "取消"
      }),
    [promptText]
  );

  return { appModal, resolveAppModal, promptText, confirmAction, showTextDialog };
}
