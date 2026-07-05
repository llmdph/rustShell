import type { MouseEvent, ReactNode } from "react";
import { Calculator, ChevronRight, FolderSync, ListChecks, Upload } from "lucide-react";

import { AppSelect, type SelectOption } from "@/components/app/AppSelect";
import { IconButton } from "@/components/app/IconButton";
import { WindowControls, type WindowAction } from "@/components/app/WindowControls";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";

import type { CompareView } from "@/features/files/filePaneTypes";

import { DirectoryCompareSummary } from "./DirectoryCompareSummary";

type DirectoryCompareSummaryData = {
  same: number;
  different: number;
  onlyLocal: number;
  onlyRemote: number;
};

type FileManagerShellProps = {
  collapsed: boolean;
  standaloneWindow: boolean;
  profileValue: string;
  profileOptions: SelectOption[];
  compareDirectories: boolean;
  canToggleCompare: boolean;
  canImportSyncPlan: boolean;
  canCompareSelectedSha256: boolean;
  compareSummary: DirectoryCompareSummaryData;
  compareView: CompareView;
  compareTotalCount: number;
  compareDiffCount: number;
  canRemoteCompareActions: boolean;
  children: ReactNode;
  onOpenPanel: () => void;
  onStartWindowDrag?: (event: MouseEvent<HTMLDivElement>) => void;
  onSelectProfile: (value: string) => void;
  onToggleCompare: () => void;
  onImportSyncPlan: () => void;
  onCompareSelectedSha256: () => void;
  onOpenTransferQueue: () => void;
  onCollapsePanel: () => void;
  onWindowAction: (action: WindowAction) => void;
  onCompareViewChange: (view: CompareView) => void;
  onCopyCompareCsv: () => void;
  onDownloadCompareCsv: () => void;
  onCopyCompareJson: () => void;
  onDownloadCompareJson: () => void;
  onCopyCompareDiffCsv: () => void;
  onDownloadCompareDiffCsv: () => void;
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

export function FileManagerShell({
  collapsed,
  standaloneWindow,
  profileValue,
  profileOptions,
  compareDirectories,
  canToggleCompare,
  canImportSyncPlan,
  canCompareSelectedSha256,
  compareSummary,
  compareView,
  compareTotalCount,
  compareDiffCount,
  canRemoteCompareActions,
  children,
  onOpenPanel,
  onStartWindowDrag,
  onSelectProfile,
  onToggleCompare,
  onImportSyncPlan,
  onCompareSelectedSha256,
  onOpenTransferQueue,
  onCollapsePanel,
  onWindowAction,
  onCompareViewChange,
  onCopyCompareCsv,
  onDownloadCompareCsv,
  onCopyCompareJson,
  onDownloadCompareJson,
  onCopyCompareDiffCsv,
  onDownloadCompareDiffCsv,
  onSelectLocalDiff,
  onSelectRemoteDiff,
  onSelectDifferentPairs,
  onSyncUploadDiff,
  onSyncUploadMissing,
  onSyncUploadMetadata,
  onSyncDownloadDiff,
  onSyncDownloadMissing,
  onSyncDownloadMetadata
}: FileManagerShellProps) {
  return (
    <aside
      data-scroll-container
      className={cn(
        "app-surface flex min-h-0 min-w-0 flex-col overflow-hidden bg-card",
        standaloneWindow ? "rounded-md border p-2.5 shadow-lg" : "border-l px-2 py-[9px]",
        collapsed && !standaloneWindow && "hidden"
      )}
    >
      {collapsed && !standaloneWindow ? (
        <Button type="button" variant="ghost" size="icon" className="h-[30px] w-7 rounded-md border bg-card/60 p-0 hover:bg-accent" title="打开文件管理器" onClick={onOpenPanel}>
          <FolderSync size={16} />
        </Button>
      ) : (
        <section
          className={
            standaloneWindow
              ? "grid h-full min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] grid-rows-[30px_auto_minmax(0,1fr)] gap-x-2.5 gap-y-2 overflow-hidden max-[820px]:grid-cols-1 max-[820px]:grid-rows-[30px_auto_minmax(0,1fr)_minmax(0,1fr)]"
              : "mt-3 flex h-full min-h-0 flex-1 flex-col overflow-hidden border-t pt-3 first:mt-0 first:border-t-0 first:pt-0"
          }
        >
          <div
            className={cn(
              "mb-2 flex h-[30px] min-w-0 flex-nowrap items-center justify-between gap-2 overflow-hidden",
              standaloneWindow &&
                "col-span-full select-none [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_input]:[-webkit-app-region:no-drag]"
            )}
            data-tauri-drag-region={standaloneWindow ? "" : undefined}
            onMouseDown={standaloneWindow ? onStartWindowDrag : undefined}
          >
            <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold leading-[30px]" data-tauri-drag-region={standaloneWindow ? "" : undefined}>文件管理器</h3>
            {standaloneWindow && (
              <AppSelect
                className="h-7 min-w-0 basis-80 shrink grow-0"
                triggerClassName="bg-input/80 pl-2 text-[11px]"
                value={profileValue}
                options={profileOptions}
                onChange={onSelectProfile}
                ariaLabel="选择远程会话"
                disabled={profileOptions.length === 1 && !profileOptions[0].value}
              />
            )}
            <IconButton
              title={compareDirectories ? "关闭目录对比" : "开启目录对比"}
              icon={<FolderSync size={14} />}
              onClick={onToggleCompare}
              disabled={!canToggleCompare}
            />
            <IconButton
              title="导入同步计划 JSON"
              icon={<Upload size={14} />}
              onClick={onImportSyncPlan}
              disabled={!canImportSyncPlan}
            />
            <IconButton
              title="校验选中文件 SHA-256"
              icon={<Calculator size={14} />}
              onClick={onCompareSelectedSha256}
              disabled={!canCompareSelectedSha256}
            />
            <IconButton title="传输队列" icon={<ListChecks size={14} />} onClick={onOpenTransferQueue} />
            {standaloneWindow ? (
              <WindowControls onAction={onWindowAction} />
            ) : (
              <IconButton title="收起右侧" icon={<ChevronRight size={14} />} onClick={onCollapsePanel} />
            )}
          </div>

          {compareDirectories && (
            <DirectoryCompareSummary
              summary={compareSummary}
              view={compareView}
              totalCount={compareTotalCount}
              diffCount={compareDiffCount}
              canRemoteActions={canRemoteCompareActions}
              onViewChange={onCompareViewChange}
              onCopyCsv={onCopyCompareCsv}
              onDownloadCsv={onDownloadCompareCsv}
              onCopyJson={onCopyCompareJson}
              onDownloadJson={onDownloadCompareJson}
              onCopyDiffCsv={onCopyCompareDiffCsv}
              onDownloadDiffCsv={onDownloadCompareDiffCsv}
              onSelectLocalDiff={onSelectLocalDiff}
              onSelectRemoteDiff={onSelectRemoteDiff}
              onSelectDifferentPairs={onSelectDifferentPairs}
              onSyncUploadDiff={onSyncUploadDiff}
              onSyncUploadMissing={onSyncUploadMissing}
              onSyncUploadMetadata={onSyncUploadMetadata}
              onSyncDownloadDiff={onSyncDownloadDiff}
              onSyncDownloadMissing={onSyncDownloadMissing}
              onSyncDownloadMetadata={onSyncDownloadMetadata}
            />
          )}

          {children}
        </section>
      )}
    </aside>
  );
}
