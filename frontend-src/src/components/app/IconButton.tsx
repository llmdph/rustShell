import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type IconButtonProps = {
  label?: string;
  title?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
};

export function IconButton({ label, title, icon, onClick, disabled, className }: IconButtonProps) {
  const accessibleLabel = title ?? label ?? "Action";
  const button = (
    <Button
      type="button"
      variant="outline"
      size={label ? "sm" : "icon"}
      className={cn(
        "shrink-0 rounded-md bg-card/60 shadow-none",
        label ? "h-[30px] min-w-8 gap-1.5 px-2 text-xs" : "size-[30px] p-0",
        className
      )}
      onClick={onClick}
      aria-label={accessibleLabel}
      disabled={disabled}
    >
      {icon}
      {label && <span className="max-[1180px]:hidden">{label}</span>}
    </Button>
  );

  if (!title && !label) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent sideOffset={6}>{accessibleLabel}</TooltipContent>
    </Tooltip>
  );
}
