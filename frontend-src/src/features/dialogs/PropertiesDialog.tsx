import { Calculator, Check, Copy, Download } from "lucide-react";

import { DialogCheckbox, FormRow, InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FileEntry, RemotePathStats } from "@/api";
import { PermissionMatrix, PermissionSpecials } from "@/features/files/PermissionControls";
import { formatMode, formatPermissionInput, formatSymbolicMode, resolvePermissionMode } from "@/features/files/permissions";

type FileSide = "local" | "remote";

type PropertiesDialogProps = {
  side: FileSide;
  entry: FileEntry;
  targetCount: number;
  hasDirectory: boolean;
  uid: string;
  gid: string;
  mode: string;
  mtime: string;
  stats: RemotePathStats | null;
  statsLoading: boolean;
  checksum: string;
  checksumLoading: boolean;
  recursive: boolean;
  formatSize: (size: number) => string;
  formatDate: (value: string) => string;
  fileTypeLabel: (entry: FileEntry) => string;
  onUid: (uid: string) => void;
  onGid: (gid: string) => void;
  onMode: (mode: string) => void;
  onMtime: (mtime: string) => void;
  onCalculateStats: () => void;
  onCalculateChecksum: () => void;
  onCopyReport: () => void;
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onCopyJson: () => void;
  onDownloadJson: () => void;
  onRecursive: (recursive: boolean) => void;
  onClose: () => void;
  onApply: () => void;
};

export default function PropertiesDialog({
  side,
  entry,
  targetCount,
  hasDirectory,
  uid,
  gid,
  mode,
  mtime,
  stats,
  statsLoading,
  checksum,
  checksumLoading,
  recursive,
  formatSize,
  formatDate,
  fileTypeLabel,
  onUid,
  onGid,
  onMode,
  onMtime,
  onCalculateStats,
  onCalculateChecksum,
  onCopyReport,
  onCopyCsv,
  onDownloadCsv,
  onCopyJson,
  onDownloadJson,
  onRecursive,
  onClose,
  onApply
}: PropertiesDialogProps) {
  const multiple = targetCount > 1;
  const isRemote = side === "remote";
  const isSymlink = entry.fileType === "symlink";
  const displaySize = multiple ? "-" : entry.isDir && stats ? formatSize(stats.totalSize) : entry.isDir ? "-" : formatSize(entry.size);
  const resolvedMode = resolvePermissionMode(mode, entry);
  const parsedMode =
    typeof resolvedMode === "number"
      ? resolvedMode
      : Number.parseInt(formatMode(entry.permissions) || (entry.isDir ? "755" : "644"), 8);
  const modeInvalid = Boolean(mode.trim()) && resolvedMode === undefined;
  const setPermissionBit = (bit: number, checked: boolean) => {
    const next = checked ? parsedMode | bit : parsedMode & ~bit;
    onMode(formatPermissionInput(next));
  };
  return (
    <Modal title={isRemote ? "远程属性" : "本地属性"} onClose={onClose}>
      <Tabs defaultValue="summary" className="gap-3">
        <TabsList>
          <TabsTrigger value="summary">摘要</TabsTrigger>
          <TabsTrigger value="edit">修改</TabsTrigger>
          <TabsTrigger value="audit">审计</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="m-0">
          <div className="py-1">
            <InfoRow label="名称" value={entry.name} />
            {multiple && <InfoRow label="目标" value={`${targetCount} 个项目`} />}
            {!multiple && <InfoRow label="路径" value={entry.path} />}
            <InfoRow label="类型" value={fileTypeLabel(entry)} />
            {!multiple && entry.linkTarget && <InfoRow label="链接到" value={entry.linkTarget} />}
            <InfoRow label="大小" value={displaySize} />
            {!multiple && stats && <InfoRow label="文件数" value={String(stats.fileCount)} />}
            {!multiple && stats && <InfoRow label="目录数" value={String(stats.dirCount)} />}
            {!multiple && checksum && <InfoRow label="SHA-256" value={checksum} />}
            <InfoRow label="当前权限" value={formatMode(entry.permissions) || "-"} />
            {isSymlink && <InfoRow label="提示" value="符号链接会跳过权限、属主和时间修改" />}
            {isRemote && <InfoRow label="UID" value={multiple ? (uid || "混合") : entry.uid == null ? "-" : String(entry.uid)} />}
            {isRemote && <InfoRow label="GID" value={multiple ? (gid || "混合") : entry.gid == null ? "-" : String(entry.gid)} />}
            <InfoRow label="时间" value={multiple ? (mtime ? formatDate(mtime) : "混合") : formatDate(entry.modifiedAt)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {!multiple && entry.isDir && (
              <Button variant="outline" className="gap-2" onClick={onCalculateStats} disabled={statsLoading}>
                <Calculator size={14} /> {statsLoading ? "计算中" : "计算大小"}
              </Button>
            )}
            {!multiple && !entry.isDir && !isSymlink && (
              <Button variant="outline" className="gap-2" onClick={onCalculateChecksum} disabled={checksumLoading}>
                <Calculator size={14} /> {checksumLoading ? "计算中" : "计算 SHA-256"}
              </Button>
            )}
          </div>
        </TabsContent>
        <TabsContent value="edit" className="m-0">
          {isRemote && (
            <>
              <FormRow label="UID">
                <Input
                  value={uid}
                  onChange={(event) => onUid(event.target.value.replace(/\D/g, ""))}
                  placeholder={multiple ? "留空不修改" : undefined}
                />
              </FormRow>
              <FormRow label="GID">
                <Input
                  value={gid}
                  onChange={(event) => onGid(event.target.value.replace(/\D/g, ""))}
                  placeholder={multiple ? "留空不修改" : undefined}
                />
              </FormRow>
            </>
          )}
          <FormRow label="权限">
            <Input
              value={mode}
              onChange={(event) => onMode(event.target.value)}
              placeholder={multiple ? "留空不修改；也可填 u+rw,g-w" : "755 或 u+rw,g-w,o="}
            />
          </FormRow>
          <div className={`mt-2 flex items-center justify-between gap-2.5 rounded-md border bg-muted/40 px-2 py-1.5 font-mono ${modeInvalid ? "border-destructive/60" : ""}`}>
            <span className={`text-[13px] font-semibold ${modeInvalid ? "text-destructive" : ""}`}>{!mode ? "不修改" : modeInvalid ? "格式错误" : formatPermissionInput(parsedMode)}</span>
            <strong className={`min-w-0 truncate text-[13px] font-medium ${modeInvalid ? "text-destructive" : ""}`}>
              {!mode
                ? multiple
                  ? "多选保留原权限"
                  : "保留原权限"
                : modeInvalid
                  ? "示例: 755, u+rw,g-w,o=, a+rX"
                  : formatSymbolicMode(parsedMode, entry.isDir)}
            </strong>
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">支持八进制和符号模式，例如 u+rw,g-w,o= 或 a+rX。</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(entry.isDir ? ["755", "775", "700", "750"] : ["644", "664", "600", "755"]).map((preset) => (
              <Button key={preset} type="button" variant="outline" size="sm" className="font-mono text-xs" onClick={() => onMode(preset)}>
                {preset}
              </Button>
            ))}
            {multiple && (
              <Button type="button" variant="outline" size="sm" onClick={() => onMode("")}>
                不修改
              </Button>
            )}
          </div>
          <PermissionMatrix mode={parsedMode} onBit={setPermissionBit} />
          <PermissionSpecials mode={parsedMode} onBit={setPermissionBit} />
          <FormRow label="修改时间">
            <Input
              type="datetime-local"
              value={mtime}
              onChange={(event) => onMtime(event.target.value)}
              title={multiple ? "留空不修改" : undefined}
            />
          </FormRow>
          {hasDirectory && (
            <DialogCheckbox checked={recursive} onCheckedChange={onRecursive}>
              递归应用到子项
            </DialogCheckbox>
          )}
        </TabsContent>
        <TabsContent value="audit" className="m-0">
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onCopyReport}>
                <Copy size={14} /> 复制报告
              </Button>
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
          </div>
        </TabsContent>
      </Tabs>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onApply} disabled={modeInvalid}>
          <Check size={14} /> 应用
        </Button>
      </div>
    </Modal>
  );
}
