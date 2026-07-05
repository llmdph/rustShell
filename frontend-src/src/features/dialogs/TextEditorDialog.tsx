import { Save } from "lucide-react";

import { InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TextFile } from "@/api";
import type { TextPreviewPosition } from "@/features/dialogs/dialogTypes";
import type { FileSide } from "@/features/files/filePaneTypes";

type TextEditorDialogProps = {
  side: FileSide;
  file: TextFile;
  position: TextPreviewPosition;
  content: string;
  onContent: (content: string) => void;
  onClose: () => void;
  onLoadHead: () => void;
  onLoadTail: () => void;
  onSave: () => void;
};

export default function TextEditorDialog({
  side,
  file,
  position,
  content,
  onContent,
  onClose,
  onLoadHead,
  onLoadTail,
  onSave
}: TextEditorDialogProps) {
  const readOnly = file.isBinary || file.truncated;
  return (
    <Modal title={side === "local" ? "本地编辑" : "远程编辑"} onClose={onClose} wide>
      <div className="py-1">
        <InfoRow label="路径" value={file.path} />
        <InfoRow label="大小" value={formatDialogSize(file.size)} />
        <InfoRow label="模式" value={readOnly ? `只读预览 / ${position === "tail" ? "末尾" : "开头"}` : "可编辑"} />
      </div>
      {file.truncated && (
        <div className="mb-2 mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">大文件仅加载 1MB 预览</span>
          <Button type="button" variant="outline" size="sm" onClick={onLoadHead} disabled={position === "head"}>
            查看开头
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onLoadTail} disabled={position === "tail"}>
            查看末尾
          </Button>
        </div>
      )}
      <Textarea
        data-scroll-container
        className="h-[min(52vh,520px)] min-h-[260px] w-full resize-y p-2.5 font-mono text-[13px] leading-[1.45]"
        value={content}
        onChange={(event) => onContent(event.target.value)}
        readOnly={readOnly}
        spellCheck={false}
      />
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onSave} disabled={readOnly}>
          <Save size={14} /> 保存
        </Button>
      </div>
    </Modal>
  );
}

function formatDialogSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
