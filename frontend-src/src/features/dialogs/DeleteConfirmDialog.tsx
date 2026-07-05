import { Copy, Download, Trash2 } from "lucide-react";

import { InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import type { FileEntry } from "@/api";
import type { FileSide } from "@/features/files/filePaneTypes";

type DeleteConfirmDialogProps = {
  side: FileSide;
  entries: FileEntry[];
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onCopyJson: () => void;
  onDownloadJson: () => void;
  onClose: () => void;
  onConfirm: () => void;
};

export default function DeleteConfirmDialog({
  side,
  entries,
  onCopyCsv,
  onDownloadCsv,
  onCopyJson,
  onDownloadJson,
  onClose,
  onConfirm
}: DeleteConfirmDialogProps) {
  const files = entries.filter((entry) => !entry.isDir);
  const dirs = entries.filter((entry) => entry.isDir);
  const bytes = files.reduce((total, entry) => total + entry.size, 0);

  return (
    <Modal title="确认删除" onClose={onClose} wide>
      <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-2 text-[13px] leading-[1.45] [&_svg]:text-destructive">
        <Trash2 size={18} />
        <span>
          将删除 {side === "local" ? "本地" : "远程"} {entries.length} 个项目，其中 {dirs.length} 个目录、{files.length} 个文件。
          {dirs.length > 0 ? "目录会递归删除其全部内容。" : ""}
        </span>
      </div>
      <div className="mt-2.5">
        <InfoRow label="文件大小合计" value={formatDialogSize(bytes)} />
        <InfoRow label="目标端" value={side === "local" ? "本地文件系统" : "远程 SFTP"} />
      </div>
      <div data-scroll-container className="mt-2.5 grid max-h-[min(34vh,320px)] overflow-auto rounded-md border">
        {entries.map((entry) => (
          <div key={entry.path} className="grid min-h-[30px] grid-cols-[54px_minmax(0,1fr)_76px] items-center gap-2 border-b px-2 py-1 text-xs last:border-b-0">
            <span className="text-muted-foreground">{entry.isDir ? "目录" : dialogFileTypeLabel(entry)}</span>
            <strong className="min-w-0 truncate font-medium">{entry.path}</strong>
            <em className="not-italic text-muted-foreground">{entry.isDir ? "递归" : formatDialogSize(entry.size)}</em>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCopyCsv}>
            <Copy size={14} /> 复制 CSV
          </Button>
          <Button variant="outline" onClick={onDownloadCsv}>
            <Download size={14} /> 下载 CSV
          </Button>
          <Button variant="outline" onClick={onCopyJson}>
            <Copy size={14} /> 复制 JSON
          </Button>
          <Button variant="outline" onClick={onDownloadJson}>
            <Download size={14} /> 下载 JSON
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="destructive" className="gap-2" onClick={onConfirm}>
            <Trash2 size={14} /> 确认删除
          </Button>
        </div>
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

function dialogFileTypeLabel(entry: FileEntry) {
  if (entry.isDir) return "目录";
  if (entry.fileType === "symlink") return "符号链接";
  return "文件";
}
