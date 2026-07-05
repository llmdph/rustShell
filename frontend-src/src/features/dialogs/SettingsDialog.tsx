import { Check, ImageIcon, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";

import { Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AppSettings } from "@/api";
import { cn } from "@/lib/utils";
import {
  backgroundGradients,
  backgroundImageValue,
  loadAppBackground,
  saveAppBackground,
  type AppBackgroundConfig
} from "@/features/shell/appBackground";
import { loadFileDockAuto, saveFileDockAuto } from "@/features/terminal/fileDockPrefs";

type SettingsDialogProps = {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
  onHostKeys: () => void;
  onSave: () => void;
};

export default function SettingsDialog({ settings, onChange, onClose, onHostKeys, onSave }: SettingsDialogProps) {
  const [background, setBackground] = useState<AppBackgroundConfig>(() => loadAppBackground());
  const [backgroundHint, setBackgroundHint] = useState("");
  const [fileDockAuto, setFileDockAuto] = useState(() => loadFileDockAuto());
  const backgroundFileRef = useRef<HTMLInputElement | null>(null);

  const updateBackground = (next: AppBackgroundConfig) => {
    setBackground(next);
    saveAppBackground(next);
  };

  const onBackgroundImage = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setBackgroundHint("图片超过 4MB，请压缩后再选择");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result : "";
      if (data) {
        updateBackground({ ...background, kind: "image", imageData: data });
        setBackgroundHint("");
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <Modal title="设置" onClose={onClose}>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="settings-theme">主题</Label>
          <Select
            value={settings.theme}
            onValueChange={(theme) => onChange({ ...settings, theme: theme as AppSettings["theme"] })}
          >
            <SelectTrigger id="settings-theme" className="w-full" aria-label="主题">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deep">Deep（暗色）</SelectItem>
              <SelectItem value="graphite">Graphite（暗色）</SelectItem>
              <SelectItem value="light">Light（亮色）</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="settings-font">字号</Label>
            <Input
              id="settings-font"
              type="number"
              value={settings.fontSize}
              onChange={(event) => onChange({ ...settings, fontSize: Number(event.target.value) })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="settings-scrollback">回滚行</Label>
            <Input
              id="settings-scrollback"
              type="number"
              value={settings.scrollback}
              onChange={(event) => onChange({ ...settings, scrollback: Number(event.target.value) })}
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="settings-shell">本地 Shell</Label>
          <Input
            id="settings-shell"
            value={settings.localShell}
            onChange={(event) => onChange({ ...settings, localShell: event.target.value })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <Label htmlFor="settings-copy" className="font-normal">选择即复制</Label>
          <Switch
            id="settings-copy"
            checked={settings.copyOnSelect}
            onCheckedChange={(checked) => onChange({ ...settings, copyOnSelect: checked })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <Label htmlFor="settings-dock" className="font-normal">连接后自动打开终端下方文件区</Label>
          <Switch
            id="settings-dock"
            checked={fileDockAuto}
            onCheckedChange={(checked) => {
              setFileDockAuto(checked);
              saveFileDockAuto(checked);
            }}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <Label htmlFor="settings-exit" className="font-normal">关闭会话前确认</Label>
          <Switch
            id="settings-exit"
            checked={settings.confirmOnExit}
            onCheckedChange={(checked) => onChange({ ...settings, confirmOnExit: checked })}
          />
        </div>
        <div className="grid gap-2">
          <Label>全局背景（即时生效，所有窗口同步）</Label>
          <Select
            value={background.kind}
            onValueChange={(kind) => updateBackground({ ...background, kind: kind as AppBackgroundConfig["kind"] })}
          >
            <SelectTrigger className="w-full" aria-label="全局背景">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">无背景</SelectItem>
              <SelectItem value="gradient">渐变预设</SelectItem>
              <SelectItem value="image">自定义图片</SelectItem>
            </SelectContent>
          </Select>
          {background.kind === "gradient" && (
            <div className="grid grid-cols-4 gap-1.5">
              {backgroundGradients.map((gradient) => (
                <button
                  key={gradient.id}
                  type="button"
                  className={cn(
                    "h-10 rounded-md border transition-shadow",
                    background.gradient === gradient.id && "ring-2 ring-ring"
                  )}
                  style={{ backgroundImage: gradient.css }}
                  title={gradient.label}
                  aria-label={gradient.label}
                  onClick={() => updateBackground({ ...background, gradient: gradient.id })}
                />
              ))}
            </div>
          )}
          {background.kind === "image" && (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => backgroundFileRef.current?.click()}>
                <ImageIcon size={14} /> 选择图片…
              </Button>
              {background.imageData ? (
                <span
                  className="h-9 w-16 rounded-md border bg-cover bg-center"
                  style={{ backgroundImage: `url("${background.imageData}")` }}
                />
              ) : (
                <span className="text-xs text-muted-foreground">未选择图片</span>
              )}
              <input
                ref={backgroundFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => onBackgroundImage(event.target.files?.[0])}
              />
            </div>
          )}
          {background.kind !== "none" && (
            <>
              <div className="relative h-20 overflow-hidden rounded-md border bg-muted">
                <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: backgroundImageValue(background) }} />
                <div className="absolute inset-0" style={{ background: "var(--background)", opacity: background.dim / 100 }} />
                <div className="absolute inset-3 grid grid-cols-[1fr_1.4fr] gap-2">
                  <div
                    className="rounded border px-2 py-1.5 text-xs font-medium"
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--card) ${background.surfaceAlpha}%, transparent)`,
                      backdropFilter: "blur(10px)"
                    }}
                  >
                    面板预览
                  </div>
                  <div
                    className="rounded border px-2 py-1.5 font-mono text-[11px]"
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--background) ${background.surfaceAlpha}%, transparent)`,
                      backdropFilter: "blur(10px)"
                    }}
                  >
                    terminal preview
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)_40px] items-center gap-2 text-xs text-muted-foreground">
                <span>背景融合</span>
                <input
                  type="range"
                  min={0}
                  max={85}
                  value={background.dim}
                  onChange={(event) => updateBackground({ ...background, dim: Number(event.target.value) })}
                />
                <span className="text-right font-mono">{background.dim}%</span>
              </div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)_40px] items-center gap-2 text-xs text-muted-foreground">
                <span>面板不透明</span>
                <input
                  type="range"
                  min={55}
                  max={100}
                  value={background.surfaceAlpha}
                  onChange={(event) => updateBackground({ ...background, surfaceAlpha: Number(event.target.value) })}
                />
                <span className="text-right font-mono">{background.surfaceAlpha}%</span>
              </div>
            </>
          )}
          {backgroundHint && <div className="text-xs text-destructive">{backgroundHint}</div>}
        </div>
        <Button variant="outline" className="w-full justify-start gap-2" onClick={onHostKeys}>
          <ShieldCheck size={14} /> 主机密钥
        </Button>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onSave}>
          <Check size={14} /> 应用
        </Button>
      </div>
    </Modal>
  );
}
