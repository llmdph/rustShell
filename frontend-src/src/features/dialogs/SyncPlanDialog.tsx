import { Copy, Download, FolderSync } from "lucide-react";

import { InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TransferConflictStrategy } from "@/api";
import type { SyncPlanItem, SyncPlanState } from "@/features/files/syncPlanTypes";
import { formatMode } from "@/features/files/permissions";
import { downloadTextFile } from "@/lib/browserFiles";
import { useClipboardFallback } from "./useClipboardFallback";

type SyncPlanDialogProps = {
  plan: SyncPlanState;
  conflict: TransferConflictStrategy;
  formatSize: (size: number) => string;
  conflictLabel: (value: TransferConflictStrategy) => string;
  onShowTextDialog: (title: string, text: string) => Promise<string | null>;
  onClose: () => void;
  onConfirm: () => void;
};

export default function SyncPlanDialog({
  plan,
  conflict,
  formatSize,
  conflictLabel,
  onShowTextDialog,
  onClose,
  onConfirm
}: SyncPlanDialogProps) {
  const createCount = plan.items.filter((item) => item.action === "create").length;
  const overwriteCount = plan.items.filter((item) => item.action === "overwrite").length;
  const metadataCount = plan.items.filter((item) => item.action === "metadata").length;
  const bytes = plan.items.reduce((total, item) => total + (item.entry.isDir ? 0 : item.entry.size), 0);
  const copyWithFallback = useClipboardFallback(onShowTextDialog);
  const copyCsv = async () => {
    const text = syncPlanCsv(plan, conflict);
    await copyWithFallback({ title: "复制同步计划 CSV", text });
  };
  const downloadCsv = () => {
    downloadTextFile(syncPlanCsvName(plan), syncPlanCsv(plan, conflict), "text/csv;charset=utf-8");
  };
  const copyJson = async () => {
    const text = syncPlanJson(plan, conflict);
    await copyWithFallback({ title: "复制同步计划 JSON", text });
  };
  const downloadJson = () => {
    downloadTextFile(syncPlanJsonName(plan), syncPlanJson(plan, conflict));
  };
  return (
    <Modal title="同步计划预览" onClose={onClose} wide>
      <Tabs defaultValue="items" className="gap-3">
        <TabsList>
          <TabsTrigger value="items">明细</TabsTrigger>
          <TabsTrigger value="summary">摘要</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="m-0">
          <div data-scroll-container className="mt-2.5 grid max-h-[min(42vh,380px)] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>动作</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>详情</TableHead>
                  <TableHead>目标</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.items.map((item) => (
                  <TableRow key={item.source}>
                    <TableCell className="text-muted-foreground">{syncPlanActionLabel(item.action)}</TableCell>
                    <TableCell className="max-w-[160px] truncate font-medium" title={item.name}>{item.name}</TableCell>
                    <TableCell className="text-muted-foreground">{item.entry.isDir ? "目录" : formatSize(item.entry.size)}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-muted-foreground" title={item.detail}>{item.detail}</TableCell>
                    <TableCell className="max-w-[240px] truncate font-mono text-muted-foreground" title={item.target}>{item.target}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        <TabsContent value="summary" className="m-0">
          <div className="grid gap-1 rounded-md border bg-muted/40 px-2.5 py-2">
            <InfoRow label="计划" value={plan.title} />
            <InfoRow label="方向" value={plan.direction === "upload" ? "本地到远程" : "远程到本地"} />
            <InfoRow label="策略" value={plan.mode === "transfer" ? conflictLabel(conflict) : "仅同步属性"} />
            <InfoRow
              label="项目"
              value={
                plan.mode === "transfer"
                  ? `${plan.items.length} 个，新增 ${createCount}，覆盖 ${overwriteCount}`
                  : `${plan.items.length} 个，元数据 ${metadataCount}`
              }
            />
            <InfoRow label="文件大小" value={formatSize(bytes)} />
          </div>
        </TabsContent>
      </Tabs>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="outline" onClick={copyCsv}>
            <Copy size={14} /> 复制 CSV
          </Button>
          <Button variant="outline" onClick={downloadCsv}>
            <Download size={14} /> 下载 CSV
          </Button>
          <Button variant="outline" onClick={copyJson}>
            <Copy size={14} /> 复制 JSON
          </Button>
          <Button variant="outline" onClick={downloadJson}>
            <Download size={14} /> 下载 JSON
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button className="gap-2" onClick={onConfirm}>
            <FolderSync size={14} /> 执行计划
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function syncPlanActionLabel(action: SyncPlanItem["action"]) {
  if (action === "create") return "新增";
  if (action === "metadata") return "元数据";
  return "覆盖";
}

function syncPlanCsvName(plan: SyncPlanState) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-sync-plan-${plan.direction}-${plan.scope}-${stamp}.csv`;
}

function syncPlanJsonName(plan: SyncPlanState) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-sync-plan-${plan.direction}-${plan.scope}-${stamp}.json`;
}

function syncPlanCsv(plan: SyncPlanState, conflict: TransferConflictStrategy) {
  const rows = [
    ["mode", "direction", "scope", "conflict_strategy", "action", "changes", "name", "type", "size", "source", "target", "detail"],
    ...plan.items.map((item) => [
      plan.mode,
      plan.direction,
      plan.scope,
      plan.mode === "transfer" ? conflict : "",
      item.action,
      item.changes?.join("|") ?? "",
      item.name,
      item.entry.isDir ? "directory" : item.entry.fileType,
      item.entry.isDir ? "" : String(item.entry.size),
      item.source,
      item.target,
      item.detail
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function syncPlanJson(plan: SyncPlanState, conflict: TransferConflictStrategy) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      title: plan.title,
      mode: plan.mode,
      direction: plan.direction,
      scope: plan.scope,
      conflictStrategy: plan.mode === "transfer" ? conflict : null,
      summary: {
        total: plan.items.length,
        create: plan.items.filter((item) => item.action === "create").length,
        overwrite: plan.items.filter((item) => item.action === "overwrite").length,
        metadata: plan.items.filter((item) => item.action === "metadata").length,
        bytes: plan.items.reduce((total, item) => total + (item.entry.isDir ? 0 : item.entry.size), 0)
      },
      items: plan.items.map((item) => {
        const source = item.sourceEntry ?? item.entry;
        const target = item.targetEntry;
        return {
          action: item.action,
          changes: item.changes ?? [],
          name: item.name,
          type: item.entry.isDir ? "directory" : item.entry.fileType,
          size: item.entry.isDir ? null : item.entry.size,
          source: item.source,
          target: item.target,
          detail: item.detail,
          sourceMode: source.permissions == null ? null : formatMode(source.permissions),
          targetMode: target?.permissions == null ? null : formatMode(target.permissions),
          sourceOwner: source.uid == null && source.gid == null ? null : `${source.uid ?? ""}:${source.gid ?? ""}`,
          targetOwner: !target || (target.uid == null && target.gid == null) ? null : `${target.uid ?? ""}:${target.gid ?? ""}`,
          sourceModifiedAt: source.modifiedAt,
          targetModifiedAt: target?.modifiedAt ?? null,
          sourceLinkTarget: source.linkTarget ?? null,
          targetLinkTarget: target?.linkTarget ?? null
        };
      })
    },
    null,
    2
  );
}

function escapeCsvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
