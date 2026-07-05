import { lazy, Suspense } from "react";

import type {
  AppSettings,
  FileEntry,
  Profile,
  QuickConnectRequest,
  RemotePathStats,
  TextFile,
  TransferConflictStrategy
} from "@/api";
import type { BatchRenamePlanItem, DeleteConfirmState, HostKeyPromptState, TextPreviewPosition } from "@/features/dialogs/dialogTypes";
import type { FileSide } from "@/features/files/filePaneTypes";
import type { SyncPlanState } from "@/features/files/syncPlanTypes";
import type { TransferQueueProps } from "@/features/transfers/TransferQueue";
import { TransferQueueDialog } from "@/features/transfers/TransferQueueDialog";
import { conflictLabel } from "@/features/transfers/transferUtils";

const LazyAppModalDialog = lazy(() => import("./AppModalDialog"));
const LazyBatchRenameDialog = lazy(() => import("./BatchRenameDialog"));
const LazyChmodDialog = lazy(() => import("./ChmodDialog"));
const LazyDeleteConfirmDialog = lazy(() => import("./DeleteConfirmDialog"));
const LazyHostKeyDialog = lazy(() => import("./HostKeyDialog"));
const LazyKnownHostsDialog = lazy(() => import("./KnownHostsDialog"));
const LazyProfileDialog = lazy(() => import("./ProfileDialog"));
const LazyPropertiesDialog = lazy(() => import("./PropertiesDialog"));
const LazyQuickDialog = lazy(() => import("./QuickDialog"));
const LazySecretDialog = lazy(() => import("./SecretDialog"));
const LazySettingsDialog = lazy(() => import("./SettingsDialog"));
const LazySyncPlanDialog = lazy(() => import("./SyncPlanDialog"));
const LazyTextEditorDialog = lazy(() => import("./TextEditorDialog"));

export type AppDialog =
  | "quick"
  | "profile"
  | "secret"
  | "settings"
  | "hostkeys"
  | "chmod"
  | "properties"
  | "editor"
  | "batchRename"
  | "deleteConfirm"
  | "syncPlan"
  | "transfers"
  | null;

export type AppModalPromptState = {
  kind: "prompt";
  title: string;
  message?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  confirmLabel: string;
  cancelLabel: string;
};

export type AppModalConfirmState = {
  kind: "confirm";
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
};

export type AppModalState = AppModalPromptState | AppModalConfirmState;

type AppDialogsProps = {
  dialog: AppDialog;
  onDialogChange: (dialog: AppDialog) => void;
  quick: QuickConnectRequest;
  onQuickChange: (quick: QuickConnectRequest) => void;
  onConnectQuick: () => void;
  secretProfile: Profile | null;
  secretPassword: string;
  onSecretPasswordChange: (profileId: string, password: string) => void;
  onCloseSecret: () => void;
  onConnectSecretProfile: () => void;
  editingProfile: Profile | null;
  onEditingProfileChange: (profile: Profile) => void;
  onSaveProfile: () => void;
  onPickProfileKeyFile: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onOpenKnownHostsManager: () => void;
  onSaveSettings: () => void;
  knownHostsText: string;
  onKnownHostsTextChange: (content: string) => void;
  onClearKnownHosts: () => void;
  onSaveKnownHosts: () => void;
  chmodTarget: FileEntry | null;
  chmodSide: FileSide;
  chmodTargets: FileEntry[];
  chmodMode: string;
  chmodRecursive: boolean;
  onChmodModeChange: (mode: string) => void;
  onChmodRecursiveChange: (recursive: boolean) => void;
  onApplyChmod: () => void;
  batchRenameSide: FileSide;
  batchRenameTargets: FileEntry[];
  batchRenameExistingEntries: FileEntry[];
  batchRenameFind: string;
  batchRenameReplace: string;
  batchRenamePrefix: string;
  batchRenameSuffix: string;
  batchRenameNumberStart: string;
  batchRenameNumberPadding: string;
  batchRenamePreserveExtension: boolean;
  batchRenameCaseSensitive: boolean;
  onBatchRenameFindChange: (value: string) => void;
  onBatchRenameReplaceChange: (value: string) => void;
  onBatchRenamePrefixChange: (value: string) => void;
  onBatchRenameSuffixChange: (value: string) => void;
  onBatchRenameNumberStartChange: (value: string) => void;
  onBatchRenameNumberPaddingChange: (value: string) => void;
  onBatchRenamePreserveExtensionChange: (value: boolean) => void;
  onBatchRenameCaseSensitiveChange: (value: boolean) => void;
  onApplyBatchRename: (items: BatchRenamePlanItem[]) => void;
  deleteConfirm: DeleteConfirmState | null;
  onCopyDeleteConfirmCsv: () => void;
  onDownloadDeleteConfirmCsv: () => void;
  onCopyDeleteConfirmJson: () => void;
  onDownloadDeleteConfirmJson: () => void;
  onCloseDeleteConfirm: () => void;
  onConfirmDeleteSelected: () => void;
  syncPlan: SyncPlanState | null;
  transferConflict: TransferConflictStrategy;
  formatSize: (size: number) => string;
  onShowTextDialog: (title: string, text: string) => Promise<string | null>;
  onCloseSyncPlan: () => void;
  onExecuteSyncPlan: () => void;
  transferQueueProps: TransferQueueProps;
  propertiesSide: FileSide;
  propertiesTarget: FileEntry | null;
  propertiesTargets: FileEntry[];
  propertiesUid: string;
  propertiesGid: string;
  propertiesMode: string;
  propertiesMtime: string;
  propertiesStats: RemotePathStats | null;
  propertiesStatsLoading: boolean;
  propertiesChecksum: string;
  propertiesChecksumLoading: boolean;
  propertiesRecursive: boolean;
  formatDate: (value: string) => string;
  fileTypeLabel: (entry: FileEntry) => string;
  onPropertiesUidChange: (uid: string) => void;
  onPropertiesGidChange: (gid: string) => void;
  onPropertiesModeChange: (mode: string) => void;
  onPropertiesMtimeChange: (mtime: string) => void;
  onCalculatePropertiesStats: () => void;
  onCalculatePropertiesChecksum: () => void;
  onCopyPropertiesReport: () => void;
  onCopyPropertiesCsv: () => void;
  onDownloadPropertiesCsv: () => void;
  onCopyPropertiesJson: () => void;
  onDownloadPropertiesJson: () => void;
  onPropertiesRecursiveChange: (recursive: boolean) => void;
  onApplyProperties: () => void;
  editorSide: FileSide;
  editorFile: TextFile | null;
  editorPreviewPosition: TextPreviewPosition;
  editorContent: string;
  onEditorContentChange: (content: string) => void;
  onLoadEditorHead: () => void;
  onLoadEditorTail: () => void;
  onSaveEditor: () => void;
  hostKeyPrompt: HostKeyPromptState | null;
  onCloseHostKeyPrompt: () => void;
  onAcceptHostKey: () => void;
  appModal: AppModalState | null;
  onResolveAppModal: (value: string | boolean | null) => void;
};

export function AppDialogs({
  dialog,
  onDialogChange,
  quick,
  onQuickChange,
  onConnectQuick,
  secretProfile,
  secretPassword,
  onSecretPasswordChange,
  onCloseSecret,
  onConnectSecretProfile,
  editingProfile,
  onEditingProfileChange,
  onSaveProfile,
  onPickProfileKeyFile,
  settings,
  onSettingsChange,
  onOpenKnownHostsManager,
  onSaveSettings,
  knownHostsText,
  onKnownHostsTextChange,
  onClearKnownHosts,
  onSaveKnownHosts,
  chmodTarget,
  chmodSide,
  chmodTargets,
  chmodMode,
  chmodRecursive,
  onChmodModeChange,
  onChmodRecursiveChange,
  onApplyChmod,
  batchRenameSide,
  batchRenameTargets,
  batchRenameExistingEntries,
  batchRenameFind,
  batchRenameReplace,
  batchRenamePrefix,
  batchRenameSuffix,
  batchRenameNumberStart,
  batchRenameNumberPadding,
  batchRenamePreserveExtension,
  batchRenameCaseSensitive,
  onBatchRenameFindChange,
  onBatchRenameReplaceChange,
  onBatchRenamePrefixChange,
  onBatchRenameSuffixChange,
  onBatchRenameNumberStartChange,
  onBatchRenameNumberPaddingChange,
  onBatchRenamePreserveExtensionChange,
  onBatchRenameCaseSensitiveChange,
  onApplyBatchRename,
  deleteConfirm,
  onCopyDeleteConfirmCsv,
  onDownloadDeleteConfirmCsv,
  onCopyDeleteConfirmJson,
  onDownloadDeleteConfirmJson,
  onCloseDeleteConfirm,
  onConfirmDeleteSelected,
  syncPlan,
  transferConflict,
  formatSize,
  onShowTextDialog,
  onCloseSyncPlan,
  onExecuteSyncPlan,
  transferQueueProps,
  propertiesSide,
  propertiesTarget,
  propertiesTargets,
  propertiesUid,
  propertiesGid,
  propertiesMode,
  propertiesMtime,
  propertiesStats,
  propertiesStatsLoading,
  propertiesChecksum,
  propertiesChecksumLoading,
  propertiesRecursive,
  formatDate,
  fileTypeLabel,
  onPropertiesUidChange,
  onPropertiesGidChange,
  onPropertiesModeChange,
  onPropertiesMtimeChange,
  onCalculatePropertiesStats,
  onCalculatePropertiesChecksum,
  onCopyPropertiesReport,
  onCopyPropertiesCsv,
  onDownloadPropertiesCsv,
  onCopyPropertiesJson,
  onDownloadPropertiesJson,
  onPropertiesRecursiveChange,
  onApplyProperties,
  editorSide,
  editorFile,
  editorPreviewPosition,
  editorContent,
  onEditorContentChange,
  onLoadEditorHead,
  onLoadEditorTail,
  onSaveEditor,
  hostKeyPrompt,
  onCloseHostKeyPrompt,
  onAcceptHostKey,
  appModal,
  onResolveAppModal
}: AppDialogsProps) {
  return (
    <>
      {dialog === "quick" && (
        <Suspense fallback={null}>
          <LazyQuickDialog
            value={quick}
            onChange={onQuickChange}
            onClose={() => onDialogChange(null)}
            onConnect={onConnectQuick}
          />
        </Suspense>
      )}

      {dialog === "secret" && secretProfile && (
        <Suspense fallback={null}>
          <LazySecretDialog
            profile={secretProfile}
            password={secretPassword}
            onPassword={(password) => onSecretPasswordChange(secretProfile.id, password)}
            onClose={onCloseSecret}
            onConnect={onConnectSecretProfile}
          />
        </Suspense>
      )}

      {dialog === "profile" && editingProfile && (
        <Suspense fallback={null}>
          <LazyProfileDialog
            profile={editingProfile}
            onChange={onEditingProfileChange}
            onClose={() => onDialogChange(null)}
            onSave={onSaveProfile}
            onPickKeyFile={onPickProfileKeyFile}
          />
        </Suspense>
      )}

      {dialog === "settings" && (
        <Suspense fallback={null}>
          <LazySettingsDialog
            settings={settings}
            onChange={onSettingsChange}
            onClose={() => onDialogChange(null)}
            onHostKeys={onOpenKnownHostsManager}
            onSave={onSaveSettings}
          />
        </Suspense>
      )}

      {dialog === "hostkeys" && (
        <Suspense fallback={null}>
          <LazyKnownHostsDialog
            content={knownHostsText}
            onChange={onKnownHostsTextChange}
            onClose={() => onDialogChange(null)}
            onClear={onClearKnownHosts}
            onSave={onSaveKnownHosts}
          />
        </Suspense>
      )}

      {dialog === "chmod" && chmodTarget && (
        <Suspense fallback={null}>
          <LazyChmodDialog
            entry={chmodTarget}
            side={chmodSide}
            targetCount={chmodTargets.length || 1}
            hasDirectory={(chmodTargets.length ? chmodTargets : [chmodTarget]).some((target) => target.isDir)}
            mode={chmodMode}
            recursive={chmodRecursive}
            onMode={onChmodModeChange}
            onRecursive={onChmodRecursiveChange}
            onClose={() => onDialogChange(null)}
            onApply={onApplyChmod}
          />
        </Suspense>
      )}

      {dialog === "batchRename" && batchRenameTargets.length > 0 && (
        <Suspense fallback={null}>
          <LazyBatchRenameDialog
            side={batchRenameSide}
            entries={batchRenameTargets}
            existingEntries={batchRenameExistingEntries}
            find={batchRenameFind}
            replace={batchRenameReplace}
            prefix={batchRenamePrefix}
            suffix={batchRenameSuffix}
            numberStart={batchRenameNumberStart}
            numberPadding={batchRenameNumberPadding}
            preserveExtension={batchRenamePreserveExtension}
            caseSensitive={batchRenameCaseSensitive}
            onFind={onBatchRenameFindChange}
            onReplace={onBatchRenameReplaceChange}
            onPrefix={onBatchRenamePrefixChange}
            onSuffix={onBatchRenameSuffixChange}
            onNumberStart={onBatchRenameNumberStartChange}
            onNumberPadding={onBatchRenameNumberPaddingChange}
            onPreserveExtension={onBatchRenamePreserveExtensionChange}
            onCaseSensitive={onBatchRenameCaseSensitiveChange}
            onClose={() => onDialogChange(null)}
            onApply={onApplyBatchRename}
          />
        </Suspense>
      )}

      {dialog === "deleteConfirm" && deleteConfirm && (
        <Suspense fallback={null}>
          <LazyDeleteConfirmDialog
            side={deleteConfirm.side}
            entries={deleteConfirm.entries}
            onCopyCsv={onCopyDeleteConfirmCsv}
            onDownloadCsv={onDownloadDeleteConfirmCsv}
            onCopyJson={onCopyDeleteConfirmJson}
            onDownloadJson={onDownloadDeleteConfirmJson}
            onClose={onCloseDeleteConfirm}
            onConfirm={onConfirmDeleteSelected}
          />
        </Suspense>
      )}

      {dialog === "syncPlan" && syncPlan && (
        <Suspense fallback={null}>
          <LazySyncPlanDialog
            plan={syncPlan}
            conflict={syncPlan.conflictStrategy ?? transferConflict}
            formatSize={formatSize}
            conflictLabel={conflictLabel}
            onShowTextDialog={onShowTextDialog}
            onClose={onCloseSyncPlan}
            onConfirm={onExecuteSyncPlan}
          />
        </Suspense>
      )}

      {dialog === "transfers" && <TransferQueueDialog open onClose={() => onDialogChange(null)} {...transferQueueProps} />}

      {dialog === "properties" && propertiesTarget && (
        <Suspense fallback={null}>
          <LazyPropertiesDialog
            side={propertiesSide}
            entry={propertiesTarget}
            targetCount={propertiesTargets.length || 1}
            hasDirectory={(propertiesTargets.length ? propertiesTargets : [propertiesTarget]).some((target) => target.isDir)}
            uid={propertiesUid}
            gid={propertiesGid}
            mode={propertiesMode}
            mtime={propertiesMtime}
            stats={propertiesStats}
            statsLoading={propertiesStatsLoading}
            checksum={propertiesChecksum}
            checksumLoading={propertiesChecksumLoading}
            recursive={propertiesRecursive}
            formatSize={formatSize}
            formatDate={formatDate}
            fileTypeLabel={fileTypeLabel}
            onUid={onPropertiesUidChange}
            onGid={onPropertiesGidChange}
            onMode={onPropertiesModeChange}
            onMtime={onPropertiesMtimeChange}
            onCalculateStats={onCalculatePropertiesStats}
            onCalculateChecksum={onCalculatePropertiesChecksum}
            onCopyReport={onCopyPropertiesReport}
            onCopyCsv={onCopyPropertiesCsv}
            onDownloadCsv={onDownloadPropertiesCsv}
            onCopyJson={onCopyPropertiesJson}
            onDownloadJson={onDownloadPropertiesJson}
            onRecursive={onPropertiesRecursiveChange}
            onClose={() => onDialogChange(null)}
            onApply={onApplyProperties}
          />
        </Suspense>
      )}

      {dialog === "editor" && editorFile && (
        <Suspense fallback={null}>
          <LazyTextEditorDialog
            side={editorSide}
            file={editorFile}
            position={editorPreviewPosition}
            content={editorContent}
            onContent={onEditorContentChange}
            onClose={() => onDialogChange(null)}
            onLoadHead={onLoadEditorHead}
            onLoadTail={onLoadEditorTail}
            onSave={onSaveEditor}
          />
        </Suspense>
      )}

      {hostKeyPrompt && (
        <Suspense fallback={null}>
          <LazyHostKeyDialog
            issue={hostKeyPrompt.issue}
            onClose={onCloseHostKeyPrompt}
            onAccept={onAcceptHostKey}
          />
        </Suspense>
      )}

      {appModal && (
        <Suspense fallback={null}>
          <LazyAppModalDialog modal={appModal} onResolve={onResolveAppModal} />
        </Suspense>
      )}
    </>
  );
}
