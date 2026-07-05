import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import type { HostKeyIssue } from "@/api";

type HostKeyDialogProps = {
  issue: HostKeyIssue;
  onClose: () => void;
  onAccept: () => void;
};

export default function HostKeyDialog({ issue, onClose, onAccept }: HostKeyDialogProps) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>主机密钥</AlertDialogTitle>
          <AlertDialogDescription>
            {issue.changed
              ? "该主机的密钥已变更，请核对指纹后再决定是否信任。"
              : "首次连接该主机，请核对指纹后再信任。"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">主机</span>
            <span className="font-mono">{issue.host}:{issue.port}</span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">类型</span>
            <span className="font-mono">{issue.keyType}</span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">指纹</span>
            <span className="break-all text-right font-mono">{issue.fingerprint}</span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">状态</span>
            <span className={issue.changed ? "font-medium text-destructive" : ""}>
              {issue.changed ? "已变更" : "未信任"}
            </span>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={onAccept}>信任</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
