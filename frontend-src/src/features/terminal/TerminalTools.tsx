import { ClipboardPaste, Copy, Eraser, FolderOpen, Plus, RefreshCcw, Send, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { TerminalView } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import { Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  loadCustomSnippets,
  saveCustomSnippets,
  type CustomSnippet
} from "./terminalSnippets";

const toolIconClass = "h-[30px] w-[30px] min-w-[30px] p-0";
const commandIconClass = "h-[26px] w-[26px] min-w-[26px] p-0";
const snippetClass =
  "h-6 border-border/80 bg-muted/30 px-1.5 font-mono text-[11px] text-muted-foreground hover:border-primary/45 hover:text-foreground";

type TerminalToolsProps = {
  activeTab: TerminalView | null;
  activeProfileAvailable: boolean;
  command: string;
  snippets: string[];
  onCommandChange: (command: string) => void;
  onSendCommand: (command: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onReconnect: () => void;
  onCloseActive: () => void;
  fileDockOpen: boolean;
  onToggleFileDock: () => void;
};

export function TerminalTools({
  activeTab,
  activeProfileAvailable,
  command,
  snippets,
  onCommandChange,
  onSendCommand,
  onCopy,
  onPaste,
  onClear,
  onReconnect,
  onCloseActive,
  fileDockOpen,
  onToggleFileDock
}: TerminalToolsProps) {
  const connected = activeTab?.status === "connected";
  const [customSnippets, setCustomSnippets] = useState<CustomSnippet[]>(loadCustomSnippets);
  const [manageOpen, setManageOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");

  const addSnippet = () => {
    const command = draftCommand.trim();
    if (!command) return;
    const name = draftName.trim() || command;
    const next = [
      ...customSnippets,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, command }
    ];
    setCustomSnippets(next);
    saveCustomSnippets(next);
    setDraftName("");
    setDraftCommand("");
  };

  const removeSnippet = (id: string) => {
    const next = customSnippets.filter((snippet) => snippet.id !== id);
    setCustomSnippets(next);
    saveCustomSnippets(next);
  };

  return (
    <section data-terminal-tools className="relative z-[2] flex min-w-0 flex-wrap items-center gap-[7px] border-t border-border/70 bg-card/80 px-[9px] py-[5px]">
      <div className="grid grid-cols-[repeat(6,30px)] gap-1.5">
        <IconButton className={toolIconClass} title="复制终端内容" icon={<Copy size={14} />} onClick={onCopy} disabled={!activeTab} />
        <IconButton className={toolIconClass} title="粘贴到终端" icon={<ClipboardPaste size={14} />} onClick={onPaste} disabled={!connected} />
        <IconButton className={toolIconClass} title="清屏" icon={<Eraser size={14} />} onClick={onClear} disabled={!connected} />
        <IconButton className={toolIconClass} title="重连" icon={<RefreshCcw size={14} />} onClick={onReconnect} disabled={!activeProfileAvailable} />
        <IconButton className={toolIconClass} title="关闭会话" icon={<X size={14} />} onClick={onCloseActive} disabled={!activeTab} />
        <IconButton className={toolIconClass} title={fileDockOpen ? "关闭下方文件区" : "打开下方文件区"} icon={<FolderOpen size={14} />} onClick={onToggleFileDock} />
      </div>
      <div className="flex min-w-[180px] flex-1 flex-wrap gap-[5px]">
        {snippets.map((snippet) => (
          <Button
            key={snippet}
            type="button"
            variant="outline"
            size="sm"
            className={snippetClass}
            onClick={() => onSendCommand(snippet)}
            disabled={!connected}
            title={`发送 ${snippet}`}
          >
            {snippet}
          </Button>
        ))}
        {customSnippets.map((snippet) => (
          <Button
            key={snippet.id}
            type="button"
            variant="outline"
            size="sm"
            className={`${snippetClass} max-w-56`}
            onClick={() => onSendCommand(snippet.command)}
            disabled={!connected}
            title={`发送 ${snippet.command}`}
          >
            <span className="min-w-0 truncate">{snippet.name}</span>
          </Button>
        ))}
        <IconButton
          className="h-6 w-6 min-w-6 p-0"
          title="自定义快捷命令"
          icon={<Plus size={13} />}
          onClick={() => setManageOpen(true)}
        />
      </div>
      {manageOpen && (
        <Modal title="自定义快捷命令" onClose={() => setManageOpen(false)}>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="snippet-name">显示名（留空则显示命令本身）</Label>
              <Input
                id="snippet-name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="例如：查看磁盘"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="snippet-command">实际执行的命令</Label>
              <Textarea
                id="snippet-command"
                className="min-h-20 resize-y font-mono text-[13px]"
                value={draftCommand}
                onChange={(event) => setDraftCommand(event.target.value)}
                placeholder="例如：du -sh * | sort -rh | head -20"
              />
            </div>
            <Button type="button" className="w-full gap-2" onClick={addSnippet} disabled={!draftCommand.trim()}>
              <Plus size={14} /> 添加
            </Button>
            {customSnippets.length > 0 && (
              <div className="grid max-h-[min(30vh,260px)] gap-1.5 overflow-y-auto rounded-md border p-2" data-scroll-container>
                {customSnippets.map((snippet) => (
                  <div key={snippet.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium">{snippet.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={snippet.command}>{snippet.command}</div>
                    </div>
                    <IconButton
                      className="h-6 w-6 min-w-6 p-0"
                      title="删除"
                      icon={<Trash2 size={13} />}
                      onClick={() => removeSnippet(snippet.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setManageOpen(false)}>完成</Button>
          </div>
        </Modal>
      )}
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
