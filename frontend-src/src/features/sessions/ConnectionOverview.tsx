import { RefreshCcw } from "lucide-react";

import type { Profile, ServerStatus } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import { normalizeProtocolLabel } from "@/features/sessions/profileProtocol";

type ConnectionOverviewProps = {
  profile: Profile | null;
  serverStatus: ServerStatus | null;
  serverStatusLoading: boolean;
  serverStatusError: string;
  onRefreshServerStatus: () => void;
};

export function ConnectionOverview({
  profile,
  serverStatus,
  serverStatusLoading,
  serverStatusError,
  onRefreshServerStatus
}: ConnectionOverviewProps) {
  return (
    <section className="mt-0 border-t border-border/70 pt-2">
      <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold">连接概览</h3>
        <IconButton
          className="h-6 min-w-6 p-0"
          title="刷新服务器状态"
          icon={<RefreshCcw size={14} />}
          onClick={onRefreshServerStatus}
          disabled={!profile || serverStatusLoading}
        />
      </div>
      <div className="grid grid-cols-1 gap-x-2.5 gap-y-px @[235px]:grid-cols-2">
        <CompactInfoRow label="名称" value={profile?.name ?? "-"} />
        <CompactInfoRow label="主机" value={profile?.host ?? "-"} />
        <CompactInfoRow label="协议" value={normalizeProtocolLabel(profile?.protocol)} />
        <CompactInfoRow label="用户" value={profile?.username ?? "-"} />
        <CompactInfoRow label="端口" value={String(profile?.port ?? "-")} />
        {serverStatus && (
          <>
            <CompactInfoRow label="节点" value={serverStatus.hostname} />
            <CompactInfoRow label="系统" value={compactServerOs(serverStatus.os)} title={serverStatus.os} />
            <CompactInfoRow label="运行" value={compactUptime(serverStatus.uptime)} title={serverStatus.uptime} />
            <CompactInfoRow label="负载" value={serverStatus.loadAverage} />
            <CompactInfoRow label="CPU" value={serverStatus.cpu} />
            <CompactInfoRow label="内存" value={serverStatus.memory} />
            <CompactInfoRow label="磁盘" value={serverStatus.disk} />
          </>
        )}
      </div>
      {!serverStatus && (
        <div className="pt-1 text-[11px] leading-tight text-muted-foreground">
          {serverStatusLoading ? "正在读取服务器状态..." : serverStatusError ? `状态读取失败: ${serverStatusError}` : "暂无状态数据"}
        </div>
      )}
    </section>
  );
}

function CompactInfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="grid min-h-[17px] grid-cols-[36px_minmax(0,1fr)] gap-1.5 text-[11px] leading-tight text-muted-foreground/90">
      <span>{label}</span>
      <strong className="truncate font-medium text-foreground/85" title={title ?? value}>
        {value}
      </strong>
    </div>
  );
}

function compactServerOs(value: string) {
  const text = value.trim();
  if (!text || text === "-") return "-";
  const linuxMatch = text.match(/^Linux\s+(\S+)/i);
  if (linuxMatch) {
    const version = linuxMatch[1].split("-")[0];
    const arch = text.match(/\b(x86_64|aarch64|arm64|amd64|i386|i686)\b/i)?.[1];
    return ["Linux", version, arch].filter(Boolean).join(" ");
  }
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

function compactUptime(value: string) {
  const text = value.trim().replace(/^up\s+/i, "");
  if (!text || text === "-") return "-";
  const units: Array<[RegExp, string]> = [
    [/(\d+)\s+years?/i, "年"],
    [/(\d+)\s+weeks?/i, "周"],
    [/(\d+)\s+days?/i, "天"],
    [/(\d+)\s+hours?/i, "时"],
    [/(\d+)\s+minutes?/i, "分"]
  ];
  const parts = units
    .map(([pattern, label]) => {
      const match = text.match(pattern);
      return match ? `${match[1]}${label}` : null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.slice(0, 2).join(" ");

  const clock = text.match(/(?:(\d+)\s+days?,?\s*)?(\d{1,2}):(\d{2})/i);
  if (clock) {
    const day = clock[1] ? `${clock[1]}天` : null;
    const hour = `${Number(clock[2])}时`;
    const minute = `${Number(clock[3])}分`;
    return [day, hour, minute].filter(Boolean).slice(0, 2).join(" ");
  }
  return text.length > 18 ? `${text.slice(0, 15)}...` : text;
}
