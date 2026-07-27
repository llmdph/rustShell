import { ChevronDown, ChevronUp, Check, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Modal } from "@/components/app/DialogPrimitives";
import { IconButton } from "@/components/app/IconButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  addSnippet,
  moveSnippet,
  removeSnippet,
  restoreDefaultSnippets,
  updateSnippet,
  useSnippets
} from "./terminalSnippets";

type SnippetManagerDialogProps = {
  onClose: () => void;
};

const rowButtonClass = "size-6 min-w-6 rounded-sm p-0";

export function SnippetManagerDialog({ onClose }: SnippetManagerDialogProps) {
  const snippets = useSnippets();
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");
  // Restoring throws away everything the user wrote, so it takes two clicks.
  // The arming state lapses on its own rather than sitting there as a trap.
  const [restoreArmed, setRestoreArmed] = useState(false);

  useEffect(() => {
    if (!restoreArmed) return;
    const timer = window.setTimeout(() => setRestoreArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [restoreArmed]);

  const submitDraft = () => {
    if (!addSnippet(draftName, draftCommand)) return;
    setDraftName("");
    setDraftCommand("");
  };

  const beginEdit = (id: string, name: string, command: string) => {
    setEditingId(id);
    setEditName(name);
    setEditCommand(command);
  };

  const commitEdit = () => {
    if (!editingId) return;
    if (!updateSnippet(editingId, editName, editCommand)) return;
    setEditingId(null);
  };

  return (
    <Modal title="快捷命令" onClose={onClose}>
      <div className="grid gap-4">
        <section className="grid gap-2.5 rounded-md border bg-muted/25 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">新增</div>
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
          <Button type="button" className="w-full gap-2" onClick={submitDraft} disabled={!draftCommand.trim()}>
            <Plus size={14} /> 添加
          </Button>
        </section>

        <section className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              已保存 · {snippets.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("h-7 gap-1.5", restoreArmed ? "text-destructive" : "text-muted-foreground")}
              onClick={() => {
                if (!restoreArmed) {
                  setRestoreArmed(true);
                  return;
                }
                restoreDefaultSnippets();
                setRestoreArmed(false);
                setEditingId(null);
              }}
            >
              <RotateCcw size={13} /> {restoreArmed ? "确认丢弃全部并恢复默认" : "恢复默认"}
            </Button>
          </div>

          {snippets.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              还没有快捷命令，先在上面添加一条。
            </p>
          ) : (
            // No scroller of its own: the modal body is already one, and nesting
            // two of them buries the footer at typical window heights.
            <div className="grid gap-1.5 rounded-md border p-2">
              {snippets.map((snippet, index) => {
                const editing = editingId === snippet.id;
                return (
                  <div
                    key={snippet.id}
                    className="rounded-md border bg-muted/30 px-2 py-1.5 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-swift)] hover:border-ring/45"
                  >
                    {editing ? (
                      <div className="grid gap-1.5">
                        <Input
                          className="h-7 text-xs"
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          placeholder="显示名"
                          aria-label="显示名"
                        />
                        <Textarea
                          className="min-h-14 resize-y font-mono text-xs"
                          value={editCommand}
                          onChange={(event) => setEditCommand(event.target.value)}
                          placeholder="命令"
                          aria-label="命令"
                        />
                        <div className="flex justify-end gap-1.5">
                          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => setEditingId(null)}>
                            <X size={13} /> 取消
                          </Button>
                          <Button type="button" size="sm" className="h-7 gap-1.5" onClick={commitEdit} disabled={!editCommand.trim()}>
                            <Check size={13} /> 保存
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{snippet.name}</div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground" title={snippet.command}>
                            {snippet.command}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <IconButton
                            className={rowButtonClass}
                            title="上移"
                            icon={<ChevronUp size={13} />}
                            disabled={index === 0}
                            onClick={() => moveSnippet(snippet.id, -1)}
                          />
                          <IconButton
                            className={rowButtonClass}
                            title="下移"
                            icon={<ChevronDown size={13} />}
                            disabled={index === snippets.length - 1}
                            onClick={() => moveSnippet(snippet.id, 1)}
                          />
                          <IconButton
                            className={rowButtonClass}
                            title="编辑"
                            icon={<Pencil size={13} />}
                            onClick={() => beginEdit(snippet.id, snippet.name, snippet.command)}
                          />
                          <IconButton
                            className={rowButtonClass}
                            title="删除"
                            icon={<Trash2 size={13} />}
                            onClick={() => removeSnippet(snippet.id)}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {/* No footer: every action here commits immediately, so a "done" button
        * would only add a row that the modal's own scroll pushes out of view.
        * The header close button and Esc are the exits. */}
    </Modal>
  );
}
