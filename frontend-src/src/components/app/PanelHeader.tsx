import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function PanelHeader({ title, action, className }: { title: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-1.5 flex h-[25px] items-center justify-between gap-2", className)}>
      <h2 className="m-0 min-w-0 truncate text-xs font-semibold">{title}</h2>
      {action}
    </div>
  );
}
