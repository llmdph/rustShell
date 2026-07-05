import { useId, type ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ModalProps = {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
};

export function Modal({ title, children, onClose, wide }: ModalProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        onOpenAutoFocus={(event) => event.preventDefault()}
        className={cn(
          "flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg"
        )}
      >
        <DialogHeader className="shrink-0 border-b px-5 py-3 text-left">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div data-scroll-container className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function InfoRow({
  label,
  value,
  title,
  className,
  labelClassName,
  valueClassName
}: {
  label: string;
  value: string;
  title?: string;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("my-[7px] grid grid-cols-[58px_minmax(0,1fr)] gap-2 text-xs text-muted-foreground", className)}>
      <span className={labelClassName}>{label}</span>
      <strong className={cn("min-w-0 truncate font-medium text-foreground", valueClassName)} title={title ?? value}>{value}</strong>
    </div>
  );
}

export function FormRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("mt-[9px] grid grid-cols-[78px_minmax(0,1fr)] items-center gap-2.5 text-[13px] text-muted-foreground", className)}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function DialogCheckbox({
  checked,
  onCheckedChange,
  children,
  className
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("mt-3 flex items-center gap-2 text-[13px]", className)}>
      <Checkbox id={id} checked={checked} onCheckedChange={(nextChecked) => onCheckedChange(nextChecked === true)} />
      <Label htmlFor={id} className="cursor-pointer font-normal">
        {children}
      </Label>
    </div>
  );
}
