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
  Trash2
} from "lucide-react";

type RemoteFilePaneActionParams = CommonFilePaneActionParams & {
  canUseRemote: boolean;
  canUseSsh: boolean;
  compareDiffCount: number;
  onOpenSelected: ActionHandler;
  onDownload: ActionHandler;
  onSyncDifference: ActionHandler;
  onCreateFile: ActionHandler;
  onCreateDirectory: ActionHandler;
  onCreateSymlink: ActionHandler;
  onDuplicate: ActionHandler;
  onMove: ActionHandler;
  onRename: ActionHandler;
  onEditSelected: EditorHandler;
  onLocateSelected: ActionHandler;
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
  onCopySymlinkCommands: ActionHandler;
  onCopySha256: ActionHandler;
  onCopySha256Csv: ActionHandler;
  onDownloadSha256Csv: ActionHandler;
  onCopySha256Json: ActionHandler;
  onDownloadSha256Json: ActionHandler;
  onCopyStatCommands: ActionHandler;
  onCopyRemoteSha256Commands: ActionHandler;
  onCopyDuCommands: ActionHandler;
  onCopyListCommands: ActionHandler;
  onCopyChmodCommands: ActionHandler;
  onCopyChownCommands: ActionHandler;
  onCopyTouchCommands: ActionHandler;
  onCopyDeleteCommands: ActionHandler;
  onCopyUris: ActionHandler;
  onCopyScpDownloadCommands: ActionHandler;
  onCopyRsyncDownloadCommands: ActionHandler;
  onCopyRsyncDownloadDryRun: ActionHandler;
  onSendPathToTerminal: ActionHandler;
  onSearch: ActionHandler;
  onOpenProperties: ActionHandler;
  onOpenChmod: ActionHandler;
  onRemove: ActionHandler;
  onSelectAll: ActionHandler;
  onInvertSelection: ActionHandler;
  onClearSelection: ActionHandler;
  onRefresh: ActionHandler;
};

type RemoteFilePaneExtraActionParams = {
  canUseRemote: boolean;
  showHidden: boolean;
  selectedEntries: FileEntry[];
  onCreateFile: ActionHandler;
  onToggleHidden: ActionHandler;
  onSearch: ActionHandler;
  onDownload: ActionHandler;
};

export function buildRemoteFilePaneActions(params: RemoteFilePaneActionParams): FileAction[] {
  const hasSelection = params.selectedEntries.length > 0;
  const hasHashableSelection = params.selectedEntries.some(isHashableFile);
  const hasLinkTarget = params.selectedEntries.some((entry) => entry.linkTarget);
  const hasRemoteSymlinkCommand = params.selectedEntries.some((entry) => entry.fileType === "symlink" && entry.linkTarget?.trim());
  const hasPermissionSelection = params.selectedEntries.some(isPermissionCommandTarget);
  const hasChownSelection = params.selectedEntries.some(
    (entry) => entry.fileType !== "symlink" && (entry.uid != null || entry.gid != null)
  );
  const hasTouchSelection = params.selectedEntries.some(isTouchCommandTarget);
  const canEditSelected = params.canUseRemote && canEditTextFile(params.selected) && params.selectedEntries.length <= 1;

  return [
    {
      label: openSelectedLabel(params.selected),
      icon: openSelectedIcon(params.selected),
      onClick: params.onOpenSelected,
      disabled: !params.canUseRemote || !params.selected || params.selectedEntries.length > 1
    },
    { label: "下载到本地", icon: <Download size={14} />, onClick: params.onDownload, disabled: !params.canUseRemote || !hasSelection },
    {
      label: "下载远程差异",
      icon: <FolderSync size={14} />,
      onClick: params.onSyncDifference,
      disabled: !params.canUseRemote || params.compareDiffCount === 0
    },
    { type: "separator" },
    { label: "新建文件", icon: <CirclePlus size={14} />, onClick: params.onCreateFile, disabled: !params.canUseRemote },
    { label: "新建目录", icon: <FolderPlus size={14} />, onClick: params.onCreateDirectory, disabled: !params.canUseRemote },
    { label: "新建软链接", icon: <Link2 size={14} />, onClick: params.onCreateSymlink, disabled: !params.canUseRemote },
    { type: "separator" },
    { label: "复制", icon: <Copy size={14} />, onClick: params.onDuplicate, disabled: !params.canUseRemote || !hasSelection },
    { label: "移动到", icon: <MoveRight size={14} />, onClick: params.onMove, disabled: !params.canUseRemote || !hasSelection },
    { label: params.selectedEntries.length > 1 ? "批量重命名" : "重命名", icon: <Edit3 size={14} />, onClick: params.onRename, disabled: !params.canUseRemote || !hasSelection },
    { type: "separator" },
    { label: "编辑文件", icon: <Edit3 size={14} />, onClick: () => params.onEditSelected(), disabled: !canEditSelected },
    { label: "查看末尾", icon: <Eye size={14} />, onClick: () => params.onEditSelected("tail"), disabled: !canEditSelected },
    { type: "separator" },
    { label: "定位所在目录", icon: <Crosshair size={14} />, onClick: params.onLocateSelected, disabled: !params.canUseRemote || !params.selected || params.selectedEntries.length > 1 },
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
    { label: "复制 ln -s 命令", icon: <Link2 size={14} />, onClick: params.onCopySymlinkCommands, disabled: !params.canUseRemote || !hasRemoteSymlinkCommand },
    { label: "复制 SHA-256", icon: <Calculator size={14} />, onClick: params.onCopySha256, disabled: !params.canUseRemote || !hasHashableSelection },
    { label: "复制 SHA-256 CSV", icon: <Copy size={14} />, onClick: params.onCopySha256Csv, disabled: !params.canUseRemote || !hasHashableSelection },
    { label: "下载 SHA-256 CSV", icon: <Download size={14} />, onClick: params.onDownloadSha256Csv, disabled: !params.canUseRemote || !hasHashableSelection },
    { label: "复制 SHA-256 JSON", icon: <Copy size={14} />, onClick: params.onCopySha256Json, disabled: !params.canUseRemote || !hasHashableSelection },
    { label: "下载 SHA-256 JSON", icon: <Download size={14} />, onClick: params.onDownloadSha256Json, disabled: !params.canUseRemote || !hasHashableSelection },
    { label: "复制 stat 命令", icon: <Settings size={14} />, onClick: params.onCopyStatCommands, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 sha256sum 命令", icon: <Calculator size={14} />, onClick: params.onCopyRemoteSha256Commands, disabled: !params.canUseRemote || !hasHashableSelection },
    { label: "复制 du 命令", icon: <Calculator size={14} />, onClick: params.onCopyDuCommands, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 ls -ld 命令", icon: <ListChecks size={14} />, onClick: params.onCopyListCommands, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 chmod 命令", icon: <ShieldCheck size={14} />, onClick: params.onCopyChmodCommands, disabled: !params.canUseRemote || !hasPermissionSelection },
    { label: "复制 chown 命令", icon: <ShieldCheck size={14} />, onClick: params.onCopyChownCommands, disabled: !params.canUseRemote || !hasChownSelection },
    { label: "复制 touch 命令", icon: <Clock size={14} />, onClick: params.onCopyTouchCommands, disabled: !params.canUseRemote || !hasTouchSelection },
    { label: "复制删除命令", icon: <Trash2 size={14} />, onClick: params.onCopyDeleteCommands, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 SFTP 地址", icon: <Link2 size={14} />, onClick: params.onCopyUris, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 scp 下载命令", icon: <Monitor size={14} />, onClick: params.onCopyScpDownloadCommands, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 rsync 下载命令", icon: <FolderSync size={14} />, onClick: params.onCopyRsyncDownloadCommands, disabled: !params.canUseRemote || !hasSelection },
    { label: "复制 rsync 下载预演", icon: <FolderSync size={14} />, onClick: params.onCopyRsyncDownloadDryRun, disabled: !params.canUseRemote || !hasSelection },
    { label: "终端进入此目录", icon: <Monitor size={14} />, onClick: params.onSendPathToTerminal, disabled: !params.canUseSsh || params.selectedEntries.length > 1 },
    { label: "搜索", icon: <Search size={14} />, onClick: params.onSearch, disabled: !params.canUseRemote },
    { label: "属性", icon: <Settings size={14} />, onClick: params.onOpenProperties, disabled: !params.canUseRemote || !hasSelection },
    { label: "权限", icon: <ShieldCheck size={14} />, onClick: params.onOpenChmod, disabled: !params.canUseRemote || !hasSelection },
    { type: "separator" },
    { label: "删除", icon: <Trash2 size={14} />, onClick: params.onRemove, disabled: !params.canUseRemote || !hasSelection, danger: true },
    { label: "全选", icon: <ListChecks size={14} />, onClick: params.onSelectAll, disabled: params.visibleFiles.length === 0 },
    { label: "反选", icon: <Check size={14} />, onClick: params.onInvertSelection, disabled: params.visibleFiles.length === 0 },
    { label: "清空选择", icon: <ListX size={14} />, onClick: params.onClearSelection, disabled: !hasSelection },
    { label: "刷新", icon: <RefreshCcw size={14} />, onClick: params.onRefresh, disabled: !params.canUseRemote }
  ];
}

export function buildRemoteFilePaneExtraActions(params: RemoteFilePaneExtraActionParams) {
  return (
    <>
      <IconButton
        title={params.showHidden ? "隐藏隐藏项" : "显示隐藏项"}
        icon={params.showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        onClick={params.onToggleHidden}
      />
      <IconButton title="新建文件" icon={<CirclePlus size={14} />} onClick={params.onCreateFile} disabled={!params.canUseRemote} />
      <IconButton title="搜索" icon={<Search size={14} />} onClick={params.onSearch} disabled={!params.canUseRemote} />
      <IconButton title="下载" icon={<Download size={14} />} onClick={params.onDownload} disabled={params.selectedEntries.length === 0} />
    </>
  );
}
