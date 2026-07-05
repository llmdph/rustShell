import { Maximize2, Minus, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export type WindowAction = "minimize" | "maximize" | "close";

type WindowControlsProps = {
  onAction: (action: WindowAction) => void;
};

export function WindowControls({ onAction }: WindowControlsProps) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]" aria-label="窗口控制">
      <Button type="button" variant="ghost" size="icon" className="h-7 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="最小化" onClick={() => onAction("minimize")}>
        <Minus size={14} />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="最大化/还原" onClick={() => onAction("maximize")}>
        <Maximize2 size={13} />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-8 rounded-md text-muted-foreground hover:bg-destructive hover:text-white" title="关闭" onClick={() => onAction("close")}>
        <X size={14} />
      </Button>
    </div>
  );
}
