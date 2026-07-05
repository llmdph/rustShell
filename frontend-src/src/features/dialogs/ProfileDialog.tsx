import { Folder, KeyRound, Save } from "lucide-react";

import { AppSelect } from "@/components/app/AppSelect";
import { DialogCheckbox, FormRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Profile, Protocol } from "@/api";
import { authProfileFromKind, profileAuthKind, profileKeyPath } from "@/features/sessions/profileAuth";
import { isRemoteProtocol, normalizeSavedProtocol, profileWithProtocol } from "@/features/sessions/profileProtocol";

type ProfileDialogProps = {
  profile: Profile;
  onChange: (profile: Profile) => void;
  onClose: () => void;
  onSave: () => void;
  onPickKeyFile: () => void;
};

export default function ProfileDialog({
  profile,
  onChange,
  onClose,
  onSave,
  onPickKeyFile
}: ProfileDialogProps) {
  const protocol = normalizeSavedProtocol(profile.protocol, profile);
  const authKind = profileAuthKind(profile.auth);
  const keyPath = profileKeyPath(profile.auth);
  const isRemote = isRemoteProtocol(protocol);
  const secretLabel = authKind === "KeyFile" ? "密钥口令/密码" : authKind === "Agent" ? "Agent 备用密码" : "连接密码";
  const secretPlaceholder =
    authKind === "KeyFile"
      ? profile.rememberPassword
        ? "留空则使用已保存口令；也可切换密码登录"
        : "加密私钥口令，或切换密码登录"
      : authKind === "Agent"
        ? "Agent 失败时可用此密码登录"
        : profile.rememberPassword
          ? "留空则使用已保存密码"
          : "输入后本次连接可直接使用";
  const switchToPasswordAuth = () =>
    onChange({
      ...profile,
      auth: "Password",
      password: profile.password ?? ""
    });
  return (
    <Modal title="会话属性" onClose={onClose} wide>
      <FormRow label="名称">
        <Input value={profile.name} onChange={(event) => onChange({ ...profile, name: event.target.value })} />
      </FormRow>
      <FormRow label="分组">
        <Input value={profile.group} onChange={(event) => onChange({ ...profile, group: event.target.value })} />
      </FormRow>
      <FormRow label="协议">
        <AppSelect<Protocol>
          value={protocol}
          ariaLabel="会话协议"
          options={[
            { value: "Ssh", label: "SSH" },
            { value: "SftpOnly", label: "SFTP" },
            { value: "LocalShell", label: "Local" },
            { value: "Serial", label: "Serial" }
          ]}
          onChange={(nextProtocol) => onChange(profileWithProtocol(profile, nextProtocol))}
        />
      </FormRow>
      <FormRow label="主机名">
        <Input value={profile.host} onChange={(event) => onChange({ ...profile, host: event.target.value })} />
      </FormRow>
      <FormRow label="端口">
        <Input type="number" value={profile.port} onChange={(event) => onChange({ ...profile, port: Number(event.target.value) })} />
      </FormRow>
      <FormRow label="用户名">
        <Input
          value={profile.username}
          autoComplete="username"
          onChange={(event) => onChange({ ...profile, username: event.target.value })}
        />
      </FormRow>
      {isRemote && (
        <div className="mt-3 rounded-md border bg-muted/40 px-3 pb-3 pt-2.5">
          <div className="flex items-center justify-between gap-2.5 max-[560px]:flex-col max-[560px]:items-start">
            <div className="text-[13px] font-semibold">SSH/SFTP 连接凭据</div>
            {authKind !== "Password" && (
              <Button type="button" variant="outline" size="sm" onClick={switchToPasswordAuth}>
                <KeyRound size={13} /> 密码登录
              </Button>
            )}
          </div>
          <FormRow label="认证方式" className="grid-cols-[92px_minmax(0,1fr)] max-[560px]:grid-cols-1">
            <AppSelect
              triggerClassName="border-primary/40 bg-card/80"
              value={authKind}
              ariaLabel="认证方式"
              options={[
                { value: "Password", label: "密码" },
                { value: "KeyFile", label: "密钥文件" },
                { value: "Agent", label: "Agent" }
              ]}
              onChange={(nextAuthKind) =>
                onChange({
                  ...profile,
                  auth: authProfileFromKind(nextAuthKind, keyPath),
                  password: profile.password
                })
              }
            />
          </FormRow>
          {authKind === "KeyFile" && (
            <FormRow label="密钥文件" className="grid-cols-[92px_minmax(0,1fr)] max-[560px]:grid-cols-1">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_68px] gap-1.5">
                <Input
                  value={keyPath}
                  onChange={(event) => onChange({ ...profile, auth: { KeyFile: { path: event.target.value } } })}
                  placeholder="例如 C:\\Users\\me\\.ssh\\id_ed25519"
                />
                <Button type="button" variant="outline" size="sm" onClick={onPickKeyFile} title="选择 SSH 私钥文件">
                  <Folder size={13} />
                  <span>选择</span>
                </Button>
                <span className="col-span-full text-[11px] leading-[1.3] text-muted-foreground">选择无 .pub 后缀的私钥文件，如 id_ed25519 或 id_rsa</span>
              </div>
            </FormRow>
          )}
          <FormRow label={secretLabel} className="grid-cols-[92px_minmax(0,1fr)] max-[560px]:grid-cols-1">
            <Input
              name="ssh-password"
              type="password"
              value={profile.password ?? ""}
              autoComplete="current-password"
              onChange={(event) =>
                onChange({
                  ...profile,
                  password: event.target.value
                })
              }
              placeholder={secretPlaceholder}
            />
          </FormRow>
          {authKind !== "Password" && (
            <FormRow label="密码登录" className="grid-cols-[92px_minmax(0,1fr)] max-[560px]:grid-cols-1">
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={switchToPasswordAuth}>
                <KeyRound size={13} /> 切换到密码认证
              </Button>
            </FormRow>
          )}
          <DialogCheckbox
            className="ml-[102px] max-[560px]:ml-0"
            checked={profile.rememberPassword}
            onCheckedChange={(rememberPassword) => onChange({ ...profile, rememberPassword })}
          >
            记住密码/口令
          </DialogCheckbox>
        </div>
      )}
      <FormRow label="字符集">
        <AppSelect
          value={profile.charset}
          ariaLabel="字符集"
          options={[
            { value: "UTF-8", label: "UTF-8" },
            { value: "GBK", label: "GBK" },
            { value: "GB18030", label: "GB18030" },
            { value: "Shift_JIS", label: "Shift_JIS" }
          ]}
          onChange={(charset) => onChange({ ...profile, charset })}
        />
      </FormRow>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onSave}>
          <Save size={14} /> 保存
        </Button>
      </div>
    </Modal>
  );
}
