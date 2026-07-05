import { ShieldCheck } from "lucide-react";

import { DialogCheckbox, FormRow, InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FileEntry } from "@/api";
import { PermissionMatrix, PermissionSpecials } from "@/features/files/PermissionControls";
import { formatMode, formatPermissionInput, formatSymbolicMode, resolvePermissionMode } from "@/features/files/permissions";

type FileSide = "local" | "remote";

type ChmodDialogProps = {
  entry: FileEntry;
  side: FileSide;
  targetCount: number;
  hasDirectory: boolean;
  mode: string;
  recursive: boolean;
  onMode: (mode: string) => void;
  onRecursive: (recursive: boolean) => void;
  onClose: () => void;
  onApply: () => void;
};

export default function ChmodDialog({
  entry,
  side: _side,
  targetCount,
  hasDirectory,
  mode,
  recursive,
  onMode,
  onRecursive,
  onClose,
  onApply
}: ChmodDialogProps) {
  const isSymlink = entry.fileType === "symlink";
  const resolvedMode = resolvePermissionMode(mode, entry);
  const parsedMode = typeof resolvedMode === "number" ? resolvedMode : Number.parseInt(formatMode(entry.permissions) || "0", 8) || 0;
  const modeInvalid = resolvedMode === undefined || resolvedMode === null;

  const setPermissionBit = (bit: number, checked: boolean) => {
    const next = checked ? parsedMode | bit : parsedMode & ~bit;
    onMode(formatPermissionInput(next));
  };

  return (
    <Modal title="修改权限" onClose={onClose}>
      <div className="py-1">
        <InfoRow label="名称" value={entry.name} />
        {targetCount > 1 && <InfoRow label="目标" value={`${targetCount} 个项目`} />}
        <InfoRow label="当前" value={formatMode(entry.permissions) || "-"} />
        {isSymlink && <InfoRow label="提示" value="符号链接会跳过权限修改" />}
      </div>
      <FormRow label="权限">
        <Input
          value={mode}
          onChange={(event) => onMode(event.target.value)}
          placeholder="755 或 u+rw,g-w,o="
        />
      </FormRow>
      <div className={`mt-2.5 flex items-center justify-between gap-2.5 rounded-md border bg-muted/40 px-2.5 py-2 font-mono ${modeInvalid ? "border-destructive/60" : ""}`}>
        <span className={`text-[13px] font-semibold ${modeInvalid ? "text-destructive" : ""}`}>{modeInvalid ? "格式错误" : formatPermissionInput(parsedMode)}</span>
        <strong className={`min-w-0 truncate text-[13px] font-medium ${modeInvalid ? "text-destructive" : ""}`}>{modeInvalid ? "示例: 755, u+rw,g-w,o=, a+rX" : formatSymbolicMode(parsedMode, entry.isDir)}</strong>
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">支持八进制和符号模式，例如 u+rw,g-w,o= 或 a+rX。</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(entry.isDir ? ["755", "775", "700", "750"] : ["644", "664", "600", "755"]).map((preset) => (
          <Button key={preset} type="button" variant="outline" size="sm" className="font-mono text-xs" onClick={() => onMode(preset)}>
            {preset}
          </Button>
        ))}
      </div>
      <PermissionMatrix mode={parsedMode} onBit={setPermissionBit} />
      <PermissionSpecials mode={parsedMode} onBit={setPermissionBit} />
      {hasDirectory && (
        <DialogCheckbox checked={recursive} onCheckedChange={onRecursive}>
          递归应用到子项
        </DialogCheckbox>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onApply} disabled={modeInvalid}>
          <ShieldCheck size={14} /> 应用
        </Button>
      </div>
    </Modal>
  );
}
