import { Cable } from "lucide-react";

import { FormRow, InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Profile } from "@/api";
import { profileAuthKind } from "@/features/sessions/profileAuth";

type SecretDialogProps = {
  profile: Profile;
  password: string;
  onPassword: (password: string) => void;
  onClose: () => void;
  onConnect: () => void;
};

export default function SecretDialog({ profile, password, onPassword, onClose, onConnect }: SecretDialogProps) {
  const authKind = profileAuthKind(profile.auth);
  const isKeyFile = authKind === "KeyFile";
  const secretLabel = isKeyFile ? "密钥口令" : "密码";
  return (
    <Modal title={isKeyFile ? "密钥口令" : "连接密码"} onClose={onClose}>
      <InfoRow label="会话" value={profile.name} />
      <InfoRow label="主机" value={`${profile.username}@${profile.host}:${profile.port}`} />
      <FormRow label={secretLabel}>
        <Input
          autoFocus
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => onPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConnect();
            }
          }}
        />
      </FormRow>
      {isKeyFile && <div className="mt-2 text-xs leading-[1.45] text-muted-foreground">私钥没有口令时可留空直接连接；如果仍失败，请确认服务器 authorized_keys 已配置对应公钥。</div>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onConnect} disabled={!isKeyFile && !password.trim()}>
          <Cable size={14} /> 连接
        </Button>
      </div>
    </Modal>
  );
}
