import type { FileEntry } from "@/api";
import type { FileAction } from "@/components/app/ActionContextMenu";
import { IconButton } from "@/components/app/IconButton";
import { canEditTextFile } from "@/features/files/filePaneModel";
import {
  isHashableFile,
  isPermissionCommandTarget,
  isTouchCommandTarget,
  openSelectedIcon,
  openSelectedLabel,
  type ActionHandler,
  type CommonFilePaneActionParams,
  type EditorHandler
} from "@/features/files/filePaneActionShared";
import {
  Calculator,
  Check,
  CirclePlus,
  Clock,
  Copy,
  Crosshair,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FolderPlus,
  FolderSync,
  Link2,
  ListChecks,
  ListX,
  Monitor,
  MoveRight,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload
} from "lucide-react";

type LocalFilePaneActionParams = CommonFilePaneActionParams & {
  localPath: string;
  canUseRemote: boolean;
  compareDiffCount: number;
  onOpenSelected: ActionHandler;
  onUpload: ActionHandler;
  onSyncDifference: ActionHandler;
  onSearch: ActionHandler;
  onCreateFile: ActionHandler;
  onCreateDirectory: ActionHandler;
  onCreateSymlink: ActionHandler;
  onDuplicate: ActionHandler;
  onMove: ActionHandler;
  onRename: ActionHandler;
  onRemove: ActionHandler;
  onCopyPaths: ActionHandler;
  onCopyNames: ActionHandler;
  onCopyParentPaths: ActionHandler;
  onCopyRelativePaths: ActionHandler;
  onCopyFileInfo: ActionHandler;
  onCopyFileInfoCsv: ActionHandler;
  onDownloadFileInfoCsv: ActionHandler;
  onCopyCurrentDirectoryCsv: ActionHandler;
  onDownloadCurrentDirectoryCsv: ActionHandler;
  onCopyLinkTargets: ActionHandler;
  onCopySha256: ActionHandler;
  onCopySha256Csv: ActionHandler;
  onDownloadSha256Csv: ActionHandler;
  onCopySha256Json: ActionHandler;
  onDownloadSha256Json: ActionHandler;
  onCopyChmodCommands: ActionHandler;
  onCopyTouchCommands: ActionHandler;
  onCopyScpUploadCommands: ActionHandler;
  onCopyRsyncUploadCommands: ActionHandler;
  onCopyRsyncUploadDryRun: ActionHandler;
  onOpenShellHere: ActionHandler;
  onRevealSelected: ActionHandler;
  onEditSelected: EditorHandler;
  onOpenProperties: ActionHandler;
  onOpenChmod: ActionHandler;
  onSelectAll: ActionHandler;
  onInvertSelection: ActionHandler;
  onClearSelection: ActionHandler;
  onRefresh: ActionHandler;
};

type LocalFilePaneExtraActionParams = {
  localPath: string;
  showHidden: boolean;
  selectedEntries: FileEntry[];
  onCreateFile: ActionHandler;
  onToggleHidden: ActionHandler;
  onSearch: ActionHandler;
  onUpload: ActionHandler;
};

export function buildLocalFilePaneActions(params: LocalFilePaneActionParams): FileAction[] {
  const hasSelection = params.selectedEntries.length > 0;
  const canUseLocalPath = params.localPath.trim().length > 0;
  const hasHashableSelection = params.selectedEntries.some(isHashableFile);
  const hasLinkTarget = params.selectedEntries.some((entry) => entry.linkTarget);
  const hasPermissionSelection = params.selectedEntries.some(isPermissionCommandTarget);
  const hasTouchSelection = params.selectedEntries.some(isTouchCommandTarget);
  const canEditSelected = canEditTextFile(params.selected) && params.selectedEntries.length <= 1;

  return [
    {
      label: openSelectedLabel(params.selected),
      icon: openSelectedIcon(params.selected),
      onClick: params.onOpenSelected,
      disabled: !params.selected || params.selectedEntries.length > 1
    },
    { label: "上传到远程", icon: <Upload size={14} />, onClick: params.onUpload, disabled: !params.canUseRemote || !hasSelection },
    {
      label: "上传本地差异",
      icon: <FolderSync size={14} />,
      onClick: params.onSyncDifference,
      disabled: !params.canUseRemote || params.compareDiffCount === 0
    },
    { label: "搜索", icon: <Search size={14} />, onClick: params.onSearch, disabled: !canUseLocalPath },
    { type: "separator" },
    { label: "新建文件", icon: <CirclePlus size={14} />, onClick: params.onCreateFile },
    { label: "新建目录", icon: <FolderPlus size={14} />, onClick: params.onCreateDirectory },
    { label: "软链接", icon: <Link2 size={14} />, onClick: params.onCreateSymlink, disabled: !canUseLocalPath },
    { type: "separator" },
    { label: "复制", icon: <Copy size={14} />, onClick: params.onDuplicate, disabled: !hasSelection },
    { label: "移动到", icon: <MoveRight size={14} />, onClick: params.onMove, disabled: !hasSelection },
    { type: "separator" },
    { label: params.selectedEntries.length > 1 ? "批量重命名" : "重命名", icon: <Edit3 size={14} />, onClick: params.onRename, disabled: !hasSelection },
    { label: "删除", icon: <Trash2 size={14} />, onClick: params.onRemove, disabled: !hasSelection, danger: true },
    { type: "separator" },
    { label: "复制路径", icon: <Copy size={14} />, onClick: params.onCopyPaths, disabled: !hasSelection },
    { label: "复制名称", icon: <Copy size={14} />, onClick: params.onCopyNames, disabled: !hasSelection },
    { label: "复制父目录路径", icon: <Copy size={14} />, onClick: params.onCopyParentPaths, disabled: !hasSelection },
    { label: "复制相对路径", icon: <Copy size={14} />, onClick: params.onCopyRelativePaths, disabled: !hasSelection },
    { label: "复制文件信息", icon: <Copy size={14} />, onClick: params.onCopyFileInfo, disabled: !hasSelection },
    { label: "复制 CSV 清单", icon: <Copy size={14} />, onClick: params.onCopyFileInfoCsv, disabled: !hasSelection },
    { label: "下载 CSV 清单", icon: <Download size={14} />, onClick: params.onDownloadFileInfoCsv, disabled: !hasSelection },
    { label: "复制当前目录 CSV", icon: <Copy size={14} />, onClick: params.onCopyCurrentDirectoryCsv, disabled: params.directoryEntryCount === 0 },
    { label: "下载当前目录 CSV", icon: <Download size={14} />, onClick: params.onDownloadCurrentDirectoryCsv, disabled: params.directoryEntryCount === 0 },
    { label: "复制链接目标", icon: <Link2 size={14} />, onClick: params.onCopyLinkTargets, disabled: !hasLinkTarget },
    { label: "复制 SHA-256", icon: <Calculator size={14} />, onClick: params.onCopySha256, disabled: !hasHashableSelection },
    { label: "复制 SHA-256 CSV", icon: <Copy size={14} />, onClick: params.onCopySha256Csv, disabled: !hasHashableSelection },
    { label: "下载 SHA-256 CSV", icon: <Download size={14} />, onClick: params.onDownloadSha256Csv, disabled: !hasHashableSelection },
    { label: "复制 SHA-256 JSON", icon: <Copy size={14} />, onClick: params.onCopySha256Json, disabled: !hasHashableSelection },
    { label: "下载 SHA-256 JSON", icon: <Download size={14} />, onClick: params.onDownloadSha256Json, disabled: !hasHashableSelection },
    { label: "复制 chmod 命令", icon: <ShieldCheck size={14} />, onClick: params.onCopyChmodCommands, disabled: !hasPermissionSelection },
    { label: "复制 touch 命令", icon: <Clock size={14} />, onClick: params.onCopyTouchCommands, disabled: !hasTouchSelection },
    {
      label: "复制 scp 上传命令",
      icon: <Monitor size={14} />,
      onClick: params.onCopyScpUploadCommands,
      disabled: !params.canUseRemote || !hasSelection
    },
    {
      label: "复制 rsync 上传命令",
      icon: <FolderSync size={14} />,
      onClick: params.onCopyRsyncUploadCommands,
      disabled: !params.canUseRemote || !hasSelection
    },
    {
      label: "复制 rsync 上传预演",
      icon: <FolderSync size={14} />,
      onClick: params.onCopyRsyncUploadDryRun,
      disabled: !params.canUseRemote || !hasSelection
    },
    { label: "本地终端进入此目录", icon: <Monitor size={14} />, onClick: params.onOpenShellHere, disabled: !canUseLocalPath || params.selectedEntries.length > 1 },
    { label: "在资源管理器中显示", icon: <Crosshair size={14} />, onClick: params.onRevealSelected, disabled: !params.selected || params.selectedEntries.length > 1 },
    { label: "编辑文件", icon: <Edit3 size={14} />, onClick: () => params.onEditSelected(), disabled: !canEditSelected },
    { label: "查看末尾", icon: <Eye size={14} />, onClick: () => params.onEditSelected("tail"), disabled: !canEditSelected },
    { label: "属性", icon: <Settings size={14} />, onClick: params.onOpenProperties, disabled: !hasSelection },
    { label: "权限", icon: <ShieldCheck size={14} />, onClick: params.onOpenChmod, disabled: !hasSelection },
    { type: "separator" },
    { label: "全选", icon: <ListChecks size={14} />, onClick: params.onSelectAll, disabled: params.visibleFiles.length === 0 },
    { label: "反选", icon: <Check size={14} />, onClick: params.onInvertSelection, disabled: params.visibleFiles.length === 0 },
    { label: "清空选择", icon: <ListX size={14} />, onClick: params.onClearSelection, disabled: !hasSelection },
    { label: "刷新", icon: <RefreshCcw size={14} />, onClick: params.onRefresh }
  ];
}

export function buildLocalFilePaneExtraActions(params: LocalFilePaneExtraActionParams) {
  const hasLocalPath = params.localPath.trim().length > 0;

  return (
    <>
      <IconButton title="新建文件" icon={<CirclePlus size={14} />} onClick={params.onCreateFile} disabled={!hasLocalPath} />
      <IconButton
        title={params.showHidden ? "隐藏隐藏项" : "显示隐藏项"}
        icon={params.showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        onClick={params.onToggleHidden}
      />
      <IconButton title="搜索" icon={<Search size={14} />} onClick={params.onSearch} disabled={!hasLocalPath} />
      <IconButton title="上传" icon={<Upload size={14} />} onClick={params.onUpload} disabled={params.selectedEntries.length === 0} />
    </>
  );
}
