import { useMemo } from "react";
import { Save } from "lucide-react";

import { DialogCheckbox, FormRow, InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FileEntry } from "@/api";
import type { BatchRenamePlanItem } from "@/features/dialogs/dialogTypes";
import type { FileSide } from "@/features/files/filePaneTypes";

type BatchRenameDialogProps = {
  side: FileSide;
  entries: FileEntry[];
  existingEntries: FileEntry[];
  find: string;
  replace: string;
  prefix: string;
  suffix: string;
  numberStart: string;
  numberPadding: string;
  preserveExtension: boolean;
  caseSensitive: boolean;
  onFind: (value: string) => void;
  onReplace: (value: string) => void;
  onPrefix: (value: string) => void;
  onSuffix: (value: string) => void;
  onNumberStart: (value: string) => void;
  onNumberPadding: (value: string) => void;
  onPreserveExtension: (value: boolean) => void;
  onCaseSensitive: (value: boolean) => void;
  onClose: () => void;
  onApply: (items: BatchRenamePlanItem[]) => void;
};

export default function BatchRenameDialog({
  side,
  entries,
  existingEntries,
  find,
  replace,
  prefix,
  suffix,
  numberStart,
  numberPadding,
  preserveExtension,
  caseSensitive,
  onFind,
  onReplace,
  onPrefix,
  onSuffix,
  onNumberStart,
  onNumberPadding,
  onPreserveExtension,
  onCaseSensitive,
  onClose,
  onApply
}: BatchRenameDialogProps) {
  const numberConfig = useMemo(() => batchRenameNumberConfig(numberStart, numberPadding), [numberPadding, numberStart]);
  const preview = useMemo(() => {
    const selectedNames = new Set(entries.map((entry) => entry.name));
    const existingNames = new Set(existingEntries.map((entry) => entry.name));
    const rows = entries.map((entry, index) => ({
      entry,
      newName: batchRenameName(entry, index, { find, replace, prefix, suffix, preserveExtension, caseSensitive, ...numberConfig })
    }));
    const counts = new Map<string, number>();
    rows.forEach((row) => counts.set(row.newName, (counts.get(row.newName) ?? 0) + 1));
    return rows.map((row) => {
      const issue = batchRenameIssue(row.entry, row.newName, counts, existingNames, selectedNames);
      return {
        ...row,
        changed: row.newName !== row.entry.name,
        issue
      };
    });
  }, [caseSensitive, entries, existingEntries, find, numberConfig, prefix, preserveExtension, replace, suffix]);
  const plan = preview.filter((row) => row.changed && !row.issue).map((row) => ({ entry: row.entry, newName: row.newName }));
  const issues = preview.filter((row) => row.issue).length;
  const numberIssue = numberConfig.invalid ? "编号起始需为 0-999999，位数需为 0-12" : "";

  return (
    <Modal title="批量重命名" onClose={onClose} wide>
      <InfoRow label="范围" value={`${side === "local" ? "本地" : "远程"} / ${entries.length} 个项目`} />
      <FormRow label="查找">
        <Input value={find} onChange={(event) => onFind(event.target.value)} placeholder="留空则只应用前缀/后缀" />
      </FormRow>
      <FormRow label="替换为">
        <Input value={replace} onChange={(event) => onReplace(event.target.value)} />
      </FormRow>
      <FormRow label="前缀">
        <Input value={prefix} onChange={(event) => onPrefix(event.target.value)} />
      </FormRow>
      <FormRow label="后缀">
        <Input value={suffix} onChange={(event) => onSuffix(event.target.value)} />
      </FormRow>
      <FormRow label="编号起始">
        <Input type="number" min="0" max="999999" value={numberStart} onChange={(event) => onNumberStart(event.target.value)} />
      </FormRow>
      <FormRow label="编号位数">
        <Input type="number" min="0" max="12" value={numberPadding} onChange={(event) => onNumberPadding(event.target.value)} />
      </FormRow>
      <DialogCheckbox checked={caseSensitive} onCheckedChange={onCaseSensitive}>
        区分大小写
      </DialogCheckbox>
      <DialogCheckbox checked={preserveExtension} onCheckedChange={onPreserveExtension}>
        保留文件扩展名
      </DialogCheckbox>
      <div className={`mt-2 text-xs ${numberIssue ? "text-destructive" : "text-muted-foreground"}`}>{numberIssue || "在查找替换、前缀或后缀中输入 {n} 可插入序号"}</div>
      <div data-scroll-container className="mt-3 grid max-h-[min(36vh,320px)] gap-1.5 overflow-auto">
        {preview.slice(0, 12).map((row) => (
          <div key={row.entry.path} className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px] items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground ${row.issue ? "border-destructive/60" : row.changed ? "border-emerald-500/40" : ""}`}>
            <span className="min-w-0 truncate">{row.entry.name}</span>
            <strong className="min-w-0 truncate font-semibold text-foreground">{row.newName}</strong>
            <em className={`text-right not-italic ${row.issue ? "text-destructive" : ""}`}>{row.issue || (row.changed ? "将重命名" : "无变化")}</em>
          </div>
        ))}
        {preview.length > 12 && <div className="text-xs text-muted-foreground">另有 {preview.length - 12} 个项目...</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span>{numberIssue || (issues ? `${issues} 个名称需要修正` : `${plan.length} 个项目将重命名`)}</span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button className="gap-2" onClick={() => onApply(plan)} disabled={!!numberIssue || plan.length === 0 || issues > 0}>
            <Save size={14} /> 应用
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function batchRenameName(
  entry: FileEntry,
  index: number,
  rule: {
    find: string;
    replace: string;
    prefix: string;
    suffix: string;
    preserveExtension: boolean;
    caseSensitive: boolean;
    start: number;
    padding: number;
  }
) {
  const parts = rule.preserveExtension && !entry.isDir ? splitFileExtension(entry.name) : { stem: entry.name, extension: "" };
  const number = String(rule.start + index).padStart(rule.padding, "0");
  const applyNumber = (value: string) => value.split("{n}").join(number);
  const replaced = rule.find
    ? rule.caseSensitive
      ? parts.stem.split(rule.find).join(applyNumber(rule.replace))
      : parts.stem.replace(new RegExp(escapeRegExp(rule.find), "gi"), applyNumber(rule.replace))
    : parts.stem;
  return `${applyNumber(rule.prefix)}${replaced}${applyNumber(rule.suffix)}${parts.extension}`.trim();
}

function splitFileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return { stem: name, extension: "" };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function batchRenameNumberConfig(start: string, padding: string) {
  const startText = start.trim();
  const paddingText = padding.trim();
  const startValue = Number.parseInt(startText, 10);
  const paddingValue = Number.parseInt(paddingText, 10);
  const invalid =
    !/^\d+$/.test(startText) ||
    !/^\d+$/.test(paddingText) ||
    !Number.isInteger(startValue) ||
    !Number.isInteger(paddingValue) ||
    startValue < 0 ||
    startValue > 999999 ||
    paddingValue < 0 ||
    paddingValue > 12;
  return {
    start: invalid ? 1 : startValue,
    padding: invalid ? 0 : paddingValue,
    invalid
  };
}

function batchRenameIssue(
  entry: FileEntry,
  newName: string,
  targetCounts: Map<string, number>,
  existingNames: Set<string>,
  selectedNames: Set<string>
) {
  if (!newName) return "名称为空";
  if (/[\\/]/.test(newName)) return "包含路径分隔符";
  if (newName === "." || newName === "..") return "名称不可用";
  if ((targetCounts.get(newName) ?? 0) > 1) return "目标重名";
  if (newName !== entry.name && selectedNames.has(newName)) return "占用原名称";
  if (newName !== entry.name && existingNames.has(newName) && !selectedNames.has(newName)) return "已存在";
  return "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
