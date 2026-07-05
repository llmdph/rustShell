import { api, type FileEntry, type Profile } from "@/api";
import { downloadTextFile } from "@/lib/browserFiles";
import {
  propertiesReportCsv,
  propertiesReportCsvName,
  propertiesReportJson,
  propertiesReportJsonName,
  propertiesReportText,
  sha256AuditCsv,
  sha256AuditCsvName,
  sha256AuditJson,
  sha256AuditJsonName,
  type PropertiesReportOptions,
  type Sha256AuditRecord
} from "@/features/files/fileReports";
import type { FileSide } from "@/features/files/filePaneTypes";
import { shouldPromptForPassword } from "@/features/sessions/profileModel";
import { isLocalProtocol } from "@/features/sessions/profileProtocol";

type CopyWithFallback = (options: {
  title: string;
  text: string;
  onCopied?: () => void;
}) => Promise<boolean>;

type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type PropertiesReportActionParams = {
  propertiesSide: FileSide;
  propertiesTarget: FileEntry | null;
  propertiesTargets: FileEntry[];
  propertiesReportOptions: PropertiesReportOptions;
  copyWithFallback: CopyWithFallback;
  pushToast: PushToast;
};

export function buildPropertiesReportActions({
  propertiesSide,
  propertiesTarget,
  propertiesTargets,
  propertiesReportOptions,
  copyWithFallback,
  pushToast
}: PropertiesReportActionParams) {
  const selectedPropertiesTargets = () => {
    if (!propertiesTarget) return null;
    return propertiesTargets.length ? propertiesTargets : [propertiesTarget];
  };

  const copyPropertiesReport = async () => {
    const targets = selectedPropertiesTargets();
    if (!targets) return;
    const text = propertiesReportText(propertiesSide, targets, propertiesReportOptions);
    await copyWithFallback({
      title: "复制属性报告",
      text,
      onCopied: () => pushToast("success", targets.length === 1 ? "属性报告已复制" : `${targets.length} 个项目的属性报告已复制`)
    });
  };

  const copyPropertiesCsv = async () => {
    const targets = selectedPropertiesTargets();
    if (!targets) return;
    const text = propertiesReportCsv(propertiesSide, targets, propertiesReportOptions);
    await copyWithFallback({
      title: "复制属性 CSV",
      text,
      onCopied: () => pushToast("success", targets.length === 1 ? "属性 CSV 已复制" : `${targets.length} 个项目的属性 CSV 已复制`)
    });
  };

  const downloadPropertiesCsv = () => {
    const targets = selectedPropertiesTargets();
    if (!targets) return;
    downloadTextFile(
      propertiesReportCsvName(propertiesSide),
      propertiesReportCsv(propertiesSide, targets, propertiesReportOptions),
      "text/csv;charset=utf-8"
    );
    pushToast("success", targets.length === 1 ? "属性 CSV 已下载" : `${targets.length} 个项目的属性 CSV 已下载`);
  };

  const copyPropertiesJson = async () => {
    const targets = selectedPropertiesTargets();
    if (!targets) return;
    const text = propertiesReportJson(propertiesSide, targets, propertiesReportOptions);
    await copyWithFallback({
      title: "复制属性 JSON",
      text,
      onCopied: () => pushToast("success", targets.length === 1 ? "属性 JSON 已复制" : `${targets.length} 个项目的属性 JSON 已复制`)
    });
  };

  const downloadPropertiesJson = () => {
    const targets = selectedPropertiesTargets();
    if (!targets) return;
    downloadTextFile(propertiesReportJsonName(propertiesSide), propertiesReportJson(propertiesSide, targets, propertiesReportOptions));
    pushToast("success", targets.length === 1 ? "属性 JSON 已下载" : `${targets.length} 个项目的属性 JSON 已下载`);
  };

  return {
    copyPropertiesReport,
    copyPropertiesCsv,
    downloadPropertiesCsv,
    copyPropertiesJson,
    downloadPropertiesJson
  };
}

type SelectedSha256ActionParams = {
  activeProfile: Profile | null;
  passwordForActive: string | null;
  visibleSelectedLocalEntries: FileEntry[];
  visibleSelectedRemoteEntries: FileEntry[];
  copyWithFallback: CopyWithFallback;
  pushToast: PushToast;
  setStatus: (status: string) => void;
  requestProfileSecret: (profile: Profile, message?: string) => void;
};

export function buildSelectedSha256Actions({
  activeProfile,
  passwordForActive,
  visibleSelectedLocalEntries,
  visibleSelectedRemoteEntries,
  copyWithFallback,
  pushToast,
  setStatus,
  requestProfileSecret
}: SelectedSha256ActionParams) {
  const collectSelectedSha256 = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    const files = entries.filter((entry) => !entry.isDir && entry.fileType !== "symlink");
    if (files.length === 0) {
      pushToast("info", "请选择普通文件计算 SHA-256");
      return null;
    }
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return null;

    const records: Sha256AuditRecord[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        const hash =
          side === "local"
            ? await api.localFileSha256(file.path)
            : await api.remoteFileSha256(activeProfile!.id, file.path, passwordForActive);
        records.push({ side, file, hash });
      } catch (error) {
        failures.push(`${file.name}: ${String(error)}`);
      }
    }
    return { records, failures };
  };

  const reportSha256Failures = (side: FileSide, failures: string[]) => {
    if (failures.length === 0) return;
    const summary = failures.slice(0, 3).join("；");
    setStatus(`SHA-256 计算失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
    pushToast("error", `SHA-256 计算失败 ${failures.length} 个文件`);
    if (side === "remote" && activeProfile && shouldPromptForPassword(activeProfile, failures[0])) {
      requestProfileSecret(activeProfile, failures[0]);
      pushToast("info", "请输入连接密码/口令");
    }
  };

  const copySelectedSha256 = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;

    if (records.length > 0) {
      const text = records.map((record) => `${record.hash}  ${record.file.path}`).join("\n");
      await copyWithFallback({ title: "复制 SHA-256", text });
      setStatus(`${side === "local" ? "本地" : "远程"} SHA-256 已复制 ${records.length} 个文件`);
      pushToast("success", records.length === 1 ? "SHA-256 已复制" : `${records.length} 个 SHA-256 已复制`);
    }
    reportSha256Failures(side, failures);
  };

  const copySelectedSha256Csv = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      const text = sha256AuditCsv(records);
      await copyWithFallback({
        title: "复制 SHA-256 CSV",
        text,
        onCopied: () => pushToast("success", records.length === 1 ? "SHA-256 CSV 已复制" : `${records.length} 个 SHA-256 CSV 已复制`)
      });
    }
    reportSha256Failures(side, failures);
  };

  const downloadSelectedSha256Csv = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      downloadTextFile(sha256AuditCsvName(side), sha256AuditCsv(records), "text/csv;charset=utf-8");
      pushToast("success", records.length === 1 ? "SHA-256 CSV 已下载" : `${records.length} 个 SHA-256 CSV 已下载`);
    }
    reportSha256Failures(side, failures);
  };

  const copySelectedSha256Json = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      const text = sha256AuditJson(records);
      await copyWithFallback({
        title: "复制 SHA-256 JSON",
        text,
        onCopied: () => pushToast("success", records.length === 1 ? "SHA-256 JSON 已复制" : `${records.length} 个 SHA-256 JSON 已复制`)
      });
    }
    reportSha256Failures(side, failures);
  };

  const downloadSelectedSha256Json = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      downloadTextFile(sha256AuditJsonName(side), sha256AuditJson(records));
      pushToast("success", records.length === 1 ? "SHA-256 JSON 已下载" : `${records.length} 个 SHA-256 JSON 已下载`);
    }
    reportSha256Failures(side, failures);
  };

  return {
    copySelectedSha256,
    copySelectedSha256Csv,
    downloadSelectedSha256Csv,
    copySelectedSha256Json,
    downloadSelectedSha256Json
  };
}
