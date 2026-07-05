import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, Crosshair, Download, Eye, Folder, RefreshCcw, Square, Trash2, Upload } from "lucide-react";
import { memo, useCallback, useMemo, useRef, type CSSProperties } from "react";

import { ActionContextMenu, type FileAction } from "@/components/app/ActionContextMenu";
import { AppSelect } from "@/components/app/AppSelect";
import { IconButton } from "@/components/app/IconButton";
import { Progress } from "@/components/ui/progress";
import type { TransferConflictStrategy, TransferView } from "@/api";
import { pathBaseName } from "@/features/files/pathUtils";
import { cn } from "@/lib/utils";
import {
  conflictLabel,
  formatEta,
  formatTransferTime,
  transferAuditRecords,
  transferDownloadResultPath,
  transferPercent,
  transferStatusLabel
} from "@/features/transfers/transferUtils";

const queueActionClass =
  "!size-7 !min-w-0 !rounded !border !border-border/70 !bg-muted/70 !p-0 !text-foreground hover:!bg-accent hover:!text-accent-foreground";
const transferRowGridClass = "grid grid-cols-[minmax(0,1fr)_58px_42px_76px_68px] items-center gap-2";
const transferCellClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";
const transferHeaderCellClass = cn(transferCellClass, "text-[11px] font-medium text-muted-foreground");
const transferStatusTextClass: Record<TransferView["status"], string> = {
  running: "text-foreground",
  done: "text-emerald-500 dark:text-emerald-400",
  failed: "text-destructive",
  cancelled: "text-muted-foreground"
};

export type TransferQueueProps = {
  transfers: TransferView[];
  history: TransferView[];
  conflict: TransferConflictStrategy;
  formatSize: (size: number) => string;
  onConflict: (value: TransferConflictStrategy) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onCancelRunning: (ids: string[]) => void;
  onRetryFailed: (ids: string[]) => void;
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onOpenLocalPath: (path: string, reveal: boolean) => void;
  onCopyDetail: (transfer: TransferView) => void;
  onLocate: (transfer: TransferView) => void;
};

export function TransferQueue({
  transfers,
  history,
  conflict,
  formatSize,
  onConflict,
  onCancel,
  onRetry,
  onRemove,
  onClear,
  onCancelRunning,
  onRetryFailed,
  onCopyCsv,
  onDownloadCsv,
  onOpenLocalPath,
  onCopyDetail,
  onLocate
}: TransferQueueProps) {
  const transferItems = useMemo(
    () => [
      ...transfers.map((transfer) => ({ transfer, archived: false })),
      ...history.map((transfer) => ({ transfer, archived: true }))
    ],
    [history, transfers]
  );
  const listBodyRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: transferItems.length,
    getItemKey: (index) => {
      const item = transferItems[index];
      return item ? `${item.archived ? "history" : "queue"}-${item.transfer.id}` : index;
    },
    getScrollElement: () => listBodyRef.current,
    estimateSize: () => 32,
    overscan: 10
  });
  const transferSummary = useMemo(() => {
    const runningIds: string[] = [];
    const retryableIds: string[] = [];
    let finishedCount = 0;

    for (const transfer of transfers) {
      if (transfer.status === "running") {
        runningIds.push(transfer.id);
        continue;
      }
      finishedCount += 1;
      if (transfer.status === "failed" || transfer.status === "cancelled") {
        retryableIds.push(transfer.id);
      }
    }

    return {
      runningIds,
      retryableIds,
      runningCount: runningIds.length,
      retryableCount: retryableIds.length,
      clearableCount: finishedCount + history.length,
      auditCount: transferAuditRecords(transfers, history).length
    };
  }, [history, transfers]);
  const { runningIds, retryableIds, runningCount, retryableCount, clearableCount, auditCount } = transferSummary;

  const localPathForTransfer = useCallback(
    (transfer: TransferView) => (transfer.direction === "upload" ? transfer.source : transferDownloadResultPath(transfer)),
    []
  );

  const contextActions = useCallback((transfer: TransferView, archived: boolean): FileAction[] => {
    const localPath = localPathForTransfer(transfer);
    const actions: FileAction[] = [
      {
        label: "打开文件",
        icon: <Eye size={13} />,
        onClick: () => onOpenLocalPath(localPath, false),
        disabled: !localPath
      },
      {
        label: "打开所在文件夹",
        icon: <Folder size={13} />,
        onClick: () => onOpenLocalPath(localPath, true),
        disabled: !localPath
      },
      { type: "separator" },
      {
        label: "定位到面板",
        icon: <Crosshair size={13} />,
        onClick: () => onLocate(transfer),
        disabled: !transfer.target && !transfer.message
      },
      {
        label: "复制传输详情",
        icon: <Copy size={13} />,
        onClick: () => onCopyDetail(transfer)
      }
    ];

    if (!archived) {
      actions.push({ type: "separator" });
      if (transfer.status === "running") {
        actions.push({
          label: "取消传输",
          icon: <Square size={13} />,
          onClick: () => onCancel(transfer.id)
        });
      } else {
        actions.push(
          {
            label: "重试传输",
            icon: <RefreshCcw size={13} />,
            onClick: () => onRetry(transfer.id)
          },
          {
            label: "移除任务",
            icon: <Trash2 size={13} />,
            onClick: () => onRemove(transfer.id),
            danger: true
          }
        );
      }
    }

    return actions;
  }, [localPathForTransfer, onCancel, onCopyDetail, onLocate, onOpenLocalPath, onRemove, onRetry]);

  return (
    <section className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-2.5 grid grid-cols-[minmax(0,1fr)_88px_auto] items-center gap-1.5">
        <h3 className="m-0 text-sm font-semibold leading-tight">
          传输队列
          {transferItems.length > 0 && (
            <span className="mt-0.5 block text-[10px] font-medium text-muted-foreground">
              {runningCount} 运行 / {retryableCount} 可重试
            </span>
          )}
        </h3>
        <AppSelect<TransferConflictStrategy>
          className="h-7 min-w-0"
          triggerClassName="text-xs"
          value={conflict}
          ariaLabel="传输冲突策略"
          options={[
            { value: "overwrite", label: "覆盖" },
            { value: "skip", label: "跳过" },
            { value: "rename", label: "重命名" },
            { value: "resume", label: "续传" }
          ]}
          onChange={onConflict}
        />
        <div className="flex gap-1">
          <IconButton className={queueActionClass} title="取消全部运行中" icon={<Square size={12} />} onClick={() => onCancelRunning(runningIds)} disabled={runningCount === 0} />
          <IconButton className={queueActionClass} title="重试失败/取消项" icon={<RefreshCcw size={12} />} onClick={() => onRetryFailed(retryableIds)} disabled={retryableCount === 0} />
          <IconButton className={queueActionClass} title="复制传输审计 CSV" icon={<Copy size={12} />} onClick={onCopyCsv} disabled={auditCount === 0} />
          <IconButton className={queueActionClass} title="下载传输审计 CSV" icon={<Download size={12} />} onClick={onDownloadCsv} disabled={auditCount === 0} />
          <IconButton className={queueActionClass} title="清理完成和历史传输" icon={<Trash2 size={12} />} onClick={onClear} disabled={clearableCount === 0} />
        </div>
      </div>
      <div className="max-h-[220px] overflow-hidden rounded border border-border bg-card/70" role="table" aria-label="传输队列" aria-rowcount={transferItems.length}>
        <div className={cn(transferRowGridClass, "sticky top-0 z-[1] min-h-7 w-full border-b border-border/70 bg-muted/90 px-1.5 text-left text-xs")} role="row">
          <span className={transferHeaderCellClass} role="columnheader">名称</span>
          <span className={transferHeaderCellClass} role="columnheader">状态</span>
          <span className={transferHeaderCellClass} role="columnheader">策略</span>
          <span className={transferHeaderCellClass} role="columnheader">大小</span>
          <span className={transferHeaderCellClass} role="columnheader">时间</span>
        </div>
        {transferItems.length === 0 ? (
          <div className="grid h-10 place-items-center text-xs text-muted-foreground">空闲</div>
        ) : (
          <div ref={listBodyRef} data-scroll-container className="max-h-48 overflow-y-auto">
            <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = transferItems[virtualRow.index];
                if (!item) return null;
                return (
                  <TransferRow
                    key={`${item.archived ? "history" : "queue"}-${item.transfer.id}`}
                    transfer={item.transfer}
                    archived={item.archived}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    formatSize={formatSize}
                    getActions={contextActions}
                    onOpenLocalPath={onOpenLocalPath}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

type TransferRowProps = {
  transfer: TransferView;
  archived: boolean;
  style: CSSProperties;
  formatSize: (size: number) => string;
  getActions: (transfer: TransferView, archived: boolean) => FileAction[];
  onOpenLocalPath: (path: string, reveal: boolean) => void;
};

const TransferRow = memo(function TransferRow({ transfer, archived, style, formatSize, getActions, onOpenLocalPath }: TransferRowProps) {
  const localPath = transfer.direction === "upload" ? transfer.source : transferDownloadResultPath(transfer);
  const actions = useMemo(() => getActions(transfer, archived), [archived, getActions, transfer]);
  const displayName = pathBaseName(localPath) || pathBaseName(transfer.source) || pathBaseName(transfer.target) || "-";
  const statusText = transferStatusLabel(transfer.status);
  const fullSizeText = `${formatSize(transfer.transferred)} / ${transfer.total ? formatSize(transfer.total) : "-"}`;
  const sizeText = transfer.total ? `${transferPercent(transfer)}% ${formatSize(transfer.total)}` : formatSize(transfer.transferred);
  const timeText = transfer.finishedAt ? formatTransferTime(transfer.finishedAt) : formatEta(transfer.etaSeconds);
  const progressValue = transfer.total ? transferPercent(transfer) : transfer.status === "done" ? 100 : 0;
  const rowTitle = [
    `${transfer.direction === "upload" ? "上传" : "下载"} ${displayName}`,
    `进度: ${fullSizeText}`,
    `源: ${transfer.source}`,
    `目标: ${transfer.target}`,
    transfer.message ? `消息: ${transfer.message}` : ""
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ActionContextMenu actions={actions}>
      <button
        type="button"
        role="row"
        style={style}
        className={cn(
          transferRowGridClass,
          "h-8 min-h-7 w-full border-0 border-l-2 border-l-transparent bg-transparent px-1.5 text-left text-xs text-foreground hover:bg-accent/70",
          archived && "text-muted-foreground",
          transfer.status === "done" && "border-l-emerald-500/70",
          transfer.status === "failed" && "border-l-destructive",
          transfer.status === "cancelled" && "text-muted-foreground"
        )}
        title={rowTitle}
        onDoubleClick={() => onOpenLocalPath(localPath, false)}
      >
        <span className={cn(transferCellClass, "inline-flex items-center gap-1.5 [&_svg]:shrink-0")} role="cell">
          {transfer.direction === "upload" ? <Upload size={13} /> : <Download size={13} />}
          <span>{displayName}</span>
        </span>
        <span className={cn(transferCellClass, transferStatusTextClass[transfer.status])} role="cell">{statusText}</span>
        <span className={transferCellClass} role="cell">{conflictLabel(transfer.conflictStrategy)}</span>
        <span className="grid min-w-0 gap-0.5" role="cell">
          <span className={transferCellClass}>{sizeText}</span>
          <Progress className="h-1" value={progressValue} />
        </span>
        <span className={transferCellClass} role="cell">{timeText}</span>
      </button>
    </ActionContextMenu>
  );
}, areTransferRowPropsEqual);

function areTransferRowPropsEqual(prev: TransferRowProps, next: TransferRowProps) {
  return (
    prev.transfer === next.transfer &&
    prev.archived === next.archived &&
    prev.formatSize === next.formatSize &&
    prev.getActions === next.getActions &&
    prev.onOpenLocalPath === next.onOpenLocalPath &&
    sameVirtualRowStyle(prev.style, next.style)
  );
}

function sameVirtualRowStyle(prev?: CSSProperties, next?: CSSProperties) {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return prev.position === next.position && prev.top === next.top && prev.left === next.left && prev.transform === next.transform;
}
