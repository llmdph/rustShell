import { Copy, Download, ListChecks, Settings, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CompareView } from "@/features/files/filePaneTypes";

const filterButtons: Array<{ value: CompareView; label: string; title: string }> = [
  { value: "all", label: "全部", title: "显示全部对比结果" },
  { value: "diff", label: "仅差异", title: "只显示仅本地、仅远程和不同项" },
  { value: "same", label: "仅相同", title: "只显示相同项" },
  { value: "only-local", label: "仅本地", title: "只显示远程不存在的本地项目" },
  { value: "only-remote", label: "仅远程", title: "只显示本地不存在的远程项目" },
  { value: "different", label: "不同", title: "只显示双侧都存在但元数据或内容特征不同的项目" }
];

const metricClassName = "inline-flex h-6 items-center rounded-md border bg-muted/60 px-2 font-mono text-[12px] text-muted-foreground";
const actionClassName =
  "h-6 gap-1 rounded-md px-2 text-[12px] data-[active=true]:border-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground";

type DirectoryCompareCounts = {
  same: number;
  different: number;
  onlyLocal: number;
  onlyRemote: number;
};

type DirectoryCompareSummaryProps = {
  summary: DirectoryCompareCounts;
  view: CompareView;
  totalCount: number;
  diffCount: number;
  canRemoteActions: boolean;
  onViewChange: (view: CompareView) => void;
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onCopyJson: () => void;
  onDownloadJson: () => void;
  onCopyDiffCsv: () => void;
  onDownloadDiffCsv: () => void;
  onSelectLocalDiff: () => void;
  onSelectRemoteDiff: () => void;
  onSelectDifferentPairs: () => void;
  onSyncUploadDiff: () => void;
  onSyncUploadMissing: () => void;
  onSyncUploadMetadata: () => void;
  onSyncDownloadDiff: () => void;
  onSyncDownloadMissing: () => void;
  onSyncDownloadMetadata: () => void;
};

export function DirectoryCompareSummary({
  summary,
  view,
  totalCount,
  diffCount,
  canRemoteActions,
  onViewChange,
  onCopyCsv,
  onDownloadCsv,
  onCopyJson,
  onDownloadJson,
  onCopyDiffCsv,
  onDownloadDiffCsv,
  onSelectLocalDiff,
  onSelectRemoteDiff,
  onSelectDifferentPairs,
  onSyncUploadDiff,
  onSyncUploadMissing,
  onSyncUploadMetadata,
  onSyncDownloadDiff,
  onSyncDownloadMissing,
  onSyncDownloadMetadata
}: DirectoryCompareSummaryProps) {
  const localDiffCount = summary.onlyLocal + summary.different;
  const remoteDiffCount = summary.onlyRemote + summary.different;

  return (
    <div className="order-1 col-span-full mb-2.5 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
      <span className={metricClassName}>仅本地 {summary.onlyLocal}</span>
      <span className={metricClassName}>仅远程 {summary.onlyRemote}</span>
      <span className={metricClassName}>不同 {summary.different}</span>
      <span className={metricClassName}>相同 {summary.same}</span>
      {filterButtons.map((item) => (
        <Button
          key={item.value}
          className={actionClassName}
          data-active={view === item.value ? "true" : undefined}
          variant="outline"
          size="sm"
          onClick={() => onViewChange(item.value)}
          title={item.title}
        >
          {item.label}
        </Button>
      ))}
      <Button className={actionClassName} variant="outline" size="sm" onClick={onCopyCsv} disabled={totalCount === 0} title="复制当前目录对比 CSV 报告">
        <Copy size={13} /> 复制 CSV
      </Button>
      <Button className={actionClassName} variant="outline" size="sm" onClick={onDownloadCsv} disabled={totalCount === 0} title="下载当前目录对比 CSV 报告">
        <Download size={13} /> 下载 CSV
      </Button>
      <Button className={actionClassName} variant="outline" size="sm" onClick={onCopyJson} disabled={totalCount === 0} title="复制当前目录对比 JSON 报告">
        <Copy size={13} /> 复制 JSON
      </Button>
      <Button className={actionClassName} variant="outline" size="sm" onClick={onDownloadJson} disabled={totalCount === 0} title="下载当前目录对比 JSON 报告">
        <Download size={13} /> 下载 JSON
      </Button>
      <Button className={actionClassName} variant="outline" size="sm" onClick={onCopyDiffCsv} disabled={diffCount === 0} title="复制仅包含差异项的目录对比 CSV">
        <Copy size={13} /> 复制差异 CSV
      </Button>
      <Button className={actionClassName} variant="outline" size="sm" onClick={onDownloadDiffCsv} disabled={diffCount === 0} title="下载仅包含差异项的目录对比 CSV">
        <Download size={13} /> 下载差异 CSV
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSelectLocalDiff}
        disabled={localDiffCount === 0}
        title="选择本地侧仅本地和不同项目"
      >
        <ListChecks size={13} /> 选本地差异
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSelectRemoteDiff}
        disabled={remoteDiffCount === 0}
        title="选择远程侧仅远程和不同项目"
      >
        <ListChecks size={13} /> 选远程差异
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSelectDifferentPairs}
        disabled={summary.different === 0}
        title="同时选择本地和远程两侧名称相同但元数据不同的项目"
      >
        <ListChecks size={13} /> 选双侧不同
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSyncUploadDiff}
        disabled={!canRemoteActions || localDiffCount === 0}
        title="上传仅本地和不同项目"
      >
        <Upload size={13} /> 上传差异
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSyncUploadMissing}
        disabled={!canRemoteActions || summary.onlyLocal === 0}
        title="只上传远程不存在的本地项目，不处理双侧不同项目"
      >
        <Upload size={13} /> 上传仅本地
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSyncUploadMetadata}
        disabled={!canRemoteActions || summary.different === 0}
        title="仅把本地权限/时间等元数据应用到远程"
      >
        <Settings size={13} /> 元数据到远程
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSyncDownloadDiff}
        disabled={!canRemoteActions || remoteDiffCount === 0}
        title="下载仅远程和不同项目"
      >
        <Download size={13} /> 下载差异
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSyncDownloadMissing}
        disabled={!canRemoteActions || summary.onlyRemote === 0}
        title="只下载本地不存在的远程项目，不处理双侧不同项目"
      >
        <Download size={13} /> 下载仅远程
      </Button>
      <Button
        className={actionClassName}
        variant="outline"
        size="sm"
        onClick={onSyncDownloadMetadata}
        disabled={!canRemoteActions || summary.different === 0}
        title="仅把远程权限/时间等元数据应用到本地"
      >
        <Settings size={13} /> 元数据到本地
      </Button>
    </div>
  );
}
