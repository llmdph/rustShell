import type { MouseEvent } from "react";

import { AppMenuBar, type AppMenuGroup } from "@/components/app/AppMenuBar";
import { WindowControls, type WindowAction } from "@/components/app/WindowControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AppTopbarProps = {
  menus: AppMenuGroup[];
  hostSearch: string;
  onHostSearchChange: (value: string) => void;
  onConnect: () => void;
  onStartWindowDrag: (event: MouseEvent<HTMLElement>) => void;
  onWindowAction: (action: WindowAction) => void;
};

export function AppTopbar({
  menus,
  hostSearch,
  onHostSearchChange,
  onConnect,
  onStartWindowDrag,
  onWindowAction
}: AppTopbarProps) {
  return (
    <header
      className="app-surface relative z-[120] flex min-w-0 select-none items-center gap-3 border-b bg-card/90 pl-3.5 pr-2.5 backdrop-blur-md [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_input]:[-webkit-app-region:no-drag]"
      onMouseDown={onStartWindowDrag}
    >
      <div className="flex w-[138px] flex-none items-center gap-2" data-tauri-drag-region>
        <img className="block size-7 select-none rounded-[7px] object-contain shadow-[0_0_0_1px_rgba(255,255,255,0.08)]" src="/rustshell-logo.png" alt="" aria-hidden="true" draggable={false} />
        <div data-tauri-drag-region>
          <div className="text-[15px] font-bold leading-[1.1]">RustShell</div>
        </div>
      </div>
      <AppMenuBar menus={menus} />
      <div className="min-w-[30px] flex-1 self-stretch" data-tauri-drag-region />
      <div className="flex min-w-[205px] flex-[0_1_300px] items-center gap-1.5 max-[1180px]:hidden">
        <Input
          className="h-7 flex-1 bg-input/60 px-2.5 text-xs"
          value={hostSearch}
          onChange={(event) => onHostSearchChange(event.target.value)}
          placeholder="主机名、IP 或会话名称"
          onKeyDown={(event) => {
            if (event.key === "Enter") onConnect();
          }}
        />
        <Button size="sm" className="h-7 px-3 text-xs font-semibold" onClick={onConnect}>
          连接
        </Button>
      </div>
      <WindowControls onAction={onWindowAction} />
    </header>
  );
}
