import { Cable } from "lucide-react";

import { AppSelect } from "@/components/app/AppSelect";
import { DialogCheckbox, FormRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Protocol, QuickConnectRequest } from "@/api";

type QuickDialogProps = {
  value: QuickConnectRequest;
  onChange: (value: QuickConnectRequest) => void;
  onClose: () => void;
  onConnect: () => void;
};

export default function QuickDialog({ value, onChange, onClose, onConnect }: QuickDialogProps) {
  return (
    <Modal title="快速连接" onClose={onClose}>
      <FormRow label="协议">
        <AppSelect<Protocol>
          value={value.protocol}
          ariaLabel="快速连接协议"
          options={[
            { value: "SSH", label: "SSH" },
            { value: "LocalShell", label: "Local" },
            { value: "SftpOnly", label: "SFTP" }
          ]}
          onChange={(protocol) => onChange({ ...value, protocol })}
        />
      </FormRow>
      <FormRow label="名称">
        <Input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
      </FormRow>
      <FormRow label="主机名">
        <Input value={value.host} onChange={(event) => onChange({ ...value, host: event.target.value })} />
      </FormRow>
      <FormRow label="端口">
        <Input type="number" value={value.port} onChange={(event) => onChange({ ...value, port: Number(event.target.value) })} />
      </FormRow>
      <FormRow label="用户名">
        <Input value={value.username} onChange={(event) => onChange({ ...value, username: event.target.value })} />
      </FormRow>
      <FormRow label="密码">
        <Input type="password" value={value.password ?? ""} onChange={(event) => onChange({ ...value, password: event.target.value })} />
      </FormRow>
      <DialogCheckbox
        checked={value.rememberPassword}
        onCheckedChange={(rememberPassword) => onChange({ ...value, rememberPassword })}
      >
        记住密码
      </DialogCheckbox>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onConnect}>
          <Cable size={14} /> 连接
        </Button>
      </div>
    </Modal>
  );
}
