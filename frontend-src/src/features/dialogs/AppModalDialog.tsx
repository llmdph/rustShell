import { useEffect, useState } from "react";

import { Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type AppModalPromptState = {
  kind: "prompt";
  title: string;
  message?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  confirmLabel: string;
  cancelLabel: string;
};

type AppModalConfirmState = {
  kind: "confirm";
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
};

type AppModalState = AppModalPromptState | AppModalConfirmState;

type AppModalDialogProps = {
  modal: AppModalState;
  onResolve: (value: string | boolean | null) => void;
};

export default function AppModalDialog({ modal, onResolve }: AppModalDialogProps) {
  const [value, setValue] = useState(modal.kind === "prompt" ? modal.value : "");

  useEffect(() => {
    setValue(modal.kind === "prompt" ? modal.value : "");
  }, [modal]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onResolve(modal.kind === "confirm" ? false : null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modal.kind, onResolve]);

  if (modal.kind === "confirm") {
    return (
      <Modal title={modal.title} onClose={() => onResolve(false)}>
        <div className="mb-3 mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/85">{modal.message}</div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onResolve(false)}>{modal.cancelLabel}</Button>
          <Button variant={modal.danger ? "destructive" : "default"} onClick={() => onResolve(true)}>
            {modal.confirmLabel}
          </Button>
        </div>
      </Modal>
    );
  }

  const submit = () => onResolve(value);
  return (
    <Modal title={modal.title} onClose={() => onResolve(null)}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {modal.message && <div className="mb-3 mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/85">{modal.message}</div>}
        {modal.multiline ? (
          <Textarea
            className="max-h-[min(48vh,360px)] min-h-40 resize-y font-mono text-[13px] leading-[1.45]"
            value={value}
            placeholder={modal.placeholder}
            readOnly={modal.readOnly}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
            }}
          />
        ) : (
          <Input
            value={value}
            placeholder={modal.placeholder}
            readOnly={modal.readOnly}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onResolve(null)}>
            {modal.cancelLabel}
          </Button>
          <Button type="submit">
            {modal.confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
