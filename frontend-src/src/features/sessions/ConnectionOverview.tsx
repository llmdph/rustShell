import { RefreshCcw } from "lucide-react";

import type { Profile, ServerStatus } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import { isLocalProtocol, normalizeProtocolLabel } from "@/features/sessions/profileProtocol";
import { cn } from "@/lib/utils";

type ConnectionOverviewProps = {
  profile: Profile | null;
  serverStatus: ServerStatus | null;
  serverStatusLoading: boolean;
  serverStatusError: string;
  linkStatus?: "disconnected" | "connecting" | "connected" | "failed" | null;
  onRefreshServerStatus: () => void;
};

const linkStatusLabel: Record<NonNullable<ConnectionOverviewProps["linkStatus"]>, string> = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
  failed: "连接失败"
};

export function ConnectionOverview({
  profile,
  serverStatus,
  serverStatusLoading,
  serverStatusError,
  linkStatus,
  onRefreshServerStatus
}: ConnectionOverviewProps) {
  const connected = linkStatus === "connected";
  const canRefresh = Boolean(profile) && (connected || isLocalProtocol(profile?.protocol));
  const showSkeleton = !serverStatus && (serverStatusLoading || linkStatus === "connecting");
  const showMeters = Boolean(serverStatus) || showSkeleton;

  return (
    <section className="border-t border-border/70 pb-0.5 pt-2">
      <div className="flex min-w-0 items-start justify-between gap-2">
        {profile ? (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="truncate text-[13px] font-medium leading-tight">{profile.name}</div>
              {linkStatus != null && (
                <>
                  <span className={"signal-dot signal-dot--" + linkStatus} />
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {linkStatusLabel[linkStatus]}
                  </span>
                </>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground" title={identityLine(profile)}>
              {identityLine(profile)}
            </div>
          </div>
        ) : (
          <p className="m-0 text-[11px] text-muted-foreground">选择一个会话查看状态</p>
        )}
        <IconButton
          className="h-6 min-w-6 shrink-0 p-0"
          title="刷新服务器状态"
          icon={<RefreshCcw size={13} className={serverStatusLoading ? "animate-spin" : undefined} />}
          onClick={onRefreshServerStatus}
          disabled={!canRefresh || serverStatusLoading}
        />
      </div>

      {showMeters && (
        <div className="mt-2.5 grid gap-1.5">
          <StatusMeter label="CPU" value={serverStatus?.cpu} loading={showSkeleton} />
          <StatusMeter label="内存" value={serverStatus?.memory} loading={showSkeleton} />
          <StatusMeter label="磁盘" value={serverStatus?.disk} loading={showSkeleton} />
        </div>
      )}

      {serverStatus ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] leading-tight text-muted-foreground">
          <MetaChip label="运行" value={compactUptime(serverStatus.uptime)} title={serverStatus.uptime} />
          <MetaChip label="负载" value={compactLoad(serverStatus.loadAverage)} title={serverStatus.loadAverage} />
          <MetaChip label="节点" value={serverStatus.hostname} />
          <MetaChip label="系统" value={compactServerOs(serverStatus.os)} title={serverStatus.os} />
        </div>
      ) : serverStatusError ? (
        <p className="mt-2 mb-0 text-[11px] leading-tight text-muted-foreground">
          状态读取失败：{serverStatusError}
        </p>
      ) : null}
    </section>
  );
}

function identityLine(profile: Profile) {
  const protocol = normalizeProtocolLabel(profile.protocol);
  const host = profile.host?.trim() || "-";
  const port = Number(profile.port || 0);
  const endpoint = port > 0 ? `${host}:${port}` : host;
  const user = profile.username?.trim();
  return [endpoint, protocol, user].filter(Boolean).join(" · ");
}

function StatusMeter({ label, value, loading }: { label: string; value?: string; loading?: boolean }) {
  const text = (value ?? "").trim();
  const empty = !text || text === "-";
  const percent = empty ? null : parsePercent(text);

  return (
    <div className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
      <div className="min-w-0">
        {loading && empty ? (
          <>
            <div className="h-[13px] w-14 animate-pulse rounded-sm bg-muted" />
            <div className="mt-0.5 h-1 animate-pulse rounded-full bg-muted" />
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[10.5px] text-foreground/85" title={empty ? undefined : text}>
                {empty ? "—" : compactMetric(text)}
              </span>
              {percent != null && <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{Math.round(percent)}%</span>}
            </div>
            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full bg-foreground/45 transition-[width] duration-[var(--duration-base)] ease-[var(--ease-swift)]",
                  percent != null && percent >= 90 && "bg-foreground/70"
                )}
                style={percent == null ? undefined : { width: `${Math.max(2, Math.min(100, percent))}%` }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetaChip({ label, value, title }: { label: string; value: string; title?: string }) {
  if (!value || value === "-") return null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1" title={title ?? value}>
      <span>{label}</span>
      <strong className="truncate font-medium text-foreground/80">{value}</strong>
    </span>
  );
}

function parsePercent(value: string) {
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const next = Number(match[1]);
  return Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : null;
}

function compactMetric(value: string) {
  return value.replace(/\s+used$/i, "").trim();
}

function compactLoad(value: string) {
  const text = value.trim();
  if (!text || text === "-") return "-";
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 3 && parts.every((part) => /^[\d.]+$/.test(part))) {
    return parts.slice(0, 3).join(" / ");
  }
  return text.length > 22 ? `${text.slice(0, 19)}…` : text;
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
  return text.length > 28 ? `${text.slice(0, 25)}…` : text;
}

function compactUptime(value: string) {
  const text = value.trim().replace(/^up\s+/i, "");
  if (!text || text === "-") return "-";
  if (/[天时分]/.test(text)) return text;
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
  return text.length > 18 ? `${text.slice(0, 15)}…` : text;
}
