import { Save } from "lucide-react";

import { Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type KnownHostsDialogProps = {
  content: string;
  onChange: (content: string) => void;
  onClose: () => void;
  onClear: () => void;
  onSave: () => void;
};

export default function KnownHostsDialog({ content, onChange, onClose, onClear, onSave }: KnownHostsDialogProps) {
  return (
    <Modal title="主机密钥管理" onClose={onClose} wide>
      <Textarea
        data-scroll-container
        className="h-[min(46vh,460px)] min-h-[260px] w-full resize-y whitespace-pre p-2.5 font-mono text-[13px] leading-[1.45]"
        value={content}
        onChange={(event) => onChange(event.target.value)}
        placeholder="known_hosts 为空。信任主机后会写入 OpenSSH known_hosts 格式。"
      />
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={onClear}>清空</Button>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onSave}>
          <Save size={14} /> 保存
        </Button>
      </div>
    </Modal>
  );
}
