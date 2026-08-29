import { ClipboardPaste, Copy, Eraser, FolderOpen, Radio, RefreshCcw, Search, Send, Settings2, X } from "lucide-react";

import type { TerminalView } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestTerminalSearch } from "./TerminalSearchOverlay";
import { useSnippets } from "./terminalSnippets";

const toolIconClass = "h-[30px] w-[30px] min-w-[30px] p-0";
const commandIconClass = "h-[26px] w-[26px] min-w-[26px] p-0";
const snippetClass =
  "h-6 max-w-56 border-border/80 bg-muted/30 px-1.5 font-mono text-[11px] text-muted-foreground transition-[color,border-color,background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-swift)] hover:border-primary/45 hover:text-foreground active:translate-y-px";

type TerminalToolsProps = {
  activeTab: TerminalView | null;
  activeProfileAvailable: boolean;
  command: string;
  broadcastOpen: boolean;
  onCommandChange: (command: string) => void;
  onSendCommand: (command: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onReconnect: () => void;
  onCloseActive: () => void;
  onToggleBroadcast: () => void;
  onManageSnippets: () => void;
  fileDockOpen: boolean;
  onToggleFileDock: () => void;
};

export function TerminalTools({
  activeTab,
  activeProfileAvailable,
  command,
  broadcastOpen,
  onCommandChange,
  onSendCommand,
  onCopy,
  onPaste,
  onClear,
  onReconnect,
  onCloseActive,
  onToggleBroadcast,
  onManageSnippets,
  fileDockOpen,
  onToggleFileDock
}: TerminalToolsProps) {
  const connected = activeTab?.status === "connected";
  const snippets = useSnippets();

  return (
    <section data-terminal-tools className="relative z-[2] flex min-w-0 flex-wrap items-center gap-[7px] border-t border-border/70 bg-card/80 px-[9px] py-[5px]">
      <div className="grid grid-cols-[repeat(8,30px)] gap-1.5">
        <IconButton className={toolIconClass} title="复制选中内容，无选区时复制整屏（Ctrl+Shift+C）" icon={<Copy size={14} />} onClick={onCopy} disabled={!activeTab} />
        <IconButton className={toolIconClass} title="粘贴到终端（Ctrl+Shift+V）" icon={<ClipboardPaste size={14} />} onClick={onPaste} disabled={!connected} />
        <IconButton
          className={toolIconClass}
          title="查找终端输出（Ctrl+F）"
          icon={<Search size={14} />}
          onClick={() => {
            if (activeTab) requestTerminalSearch(activeTab.id);
          }}
          disabled={!activeTab}
        />
        <IconButton className={toolIconClass} title="清屏" icon={<Eraser size={14} />} onClick={onClear} disabled={!connected} />
        <IconButton className={toolIconClass} title="重连" icon={<RefreshCcw size={14} />} onClick={onReconnect} disabled={!activeProfileAvailable} />
        <IconButton
          className={`${toolIconClass} ${broadcastOpen ? "border-ring/60 bg-accent text-foreground" : ""}`}
          title={broadcastOpen ? "关闭广播命令栏" : "广播命令到所有会话"}
          icon={<Radio size={14} />}
          onClick={onToggleBroadcast}
        />
        <IconButton className={toolIconClass} title={fileDockOpen ? "关闭下方文件区" : "打开下方文件区"} icon={<FolderOpen size={14} />} onClick={onToggleFileDock} />
        <IconButton className={toolIconClass} title="关闭会话" icon={<X size={14} />} onClick={onCloseActive} disabled={!activeTab} />
      </div>
      <div className="flex min-w-[180px] flex-1 flex-wrap gap-[5px]">
        {snippets.map((snippet) => (
          <Button
            key={snippet.id}
            type="button"
            variant="outline"
            size="sm"
            className={snippetClass}
            onClick={() => onSendCommand(snippet.command)}
            disabled={!connected}
            title={`发送 ${snippet.command}`}
          >
            <span className="min-w-0 truncate">{snippet.name}</span>
          </Button>
        ))}
        <IconButton
          className="h-6 w-6 min-w-6 p-0"
          title="管理快捷命令"
          icon={<Settings2 size={13} />}
          onClick={onManageSnippets}
        />
      </div>
      <div className="ml-auto grid w-[clamp(170px,24vw,260px)] grid-cols-[minmax(120px,220px)_26px] gap-1">
        <Input
          className="h-[26px] min-w-0 rounded px-2 font-mono text-xs focus-visible:ring-0"
          value={command}
          onChange={(event) => onCommandChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSendCommand(command);
            }
          }}
          placeholder="输入命令"
        />
        <IconButton
          className={commandIconClass}
          title="发送命令"
          icon={<Send size={14} />}
          onClick={() => onSendCommand(command)}
          disabled={!connected || !command.trim()}
        />
      </div>
    </section>
  );
}
