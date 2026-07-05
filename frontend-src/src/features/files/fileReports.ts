import type { FileEntry, RemotePathStats } from "@/api";
import {
  compareKindLabel,
  fileTypeLabel,
  formatEntrySymbolicMode,
  formatFileDateTime,
  formatOwner,
  formatSize
} from "@/features/files/fileFormatters";
import type { DirectoryCompare, FileSide } from "@/features/files/filePaneTypes";
import { formatMode } from "@/features/files/permissions";

export type Sha256AuditRecord = { side: FileSide; file: FileEntry; hash: string };
export type PropertiesReportOptions = {
  uid: string;
  gid: string;
  mode: string;
  mtime: string;
  stats: RemotePathStats | null;
  checksum: string;
  recursive: boolean;
};

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function fileInfoCsvName(side: FileSide) {
  return `rustshell-${side}-file-info-${timestamp()}.csv`;
}

export function sha256AuditCsvName(side: FileSide) {
  return `rustshell-${side}-sha256-audit-${timestamp()}.csv`;
}

export function sha256AuditJsonName(side: FileSide) {
  return `rustshell-${side}-sha256-audit-${timestamp()}.json`;
}

export function propertiesReportCsvName(side: FileSide) {
  return `rustshell-${side}-properties-${timestamp()}.csv`;
}

export function propertiesReportJsonName(side: FileSide) {
  return `rustshell-${side}-properties-${timestamp()}.json`;
}

export function directoryListingCsvName(side: FileSide) {
  return `rustshell-${side}-directory-listing-${timestamp()}.csv`;
}

export function deleteConfirmCsvName(side: FileSide) {
  return `rustshell-${side}-delete-confirm-${timestamp()}.csv`;
}

export function deleteConfirmJsonName(side: FileSide) {
  return `rustshell-${side}-delete-confirm-${timestamp()}.json`;
}

export function directoryCompareCsvName(scope = "all") {
  return `rustshell-directory-compare-${scope}-${timestamp()}.csv`;
}

export function directoryCompareJsonName(scope = "all") {
  return `rustshell-directory-compare-${scope}-${timestamp()}.json`;
}

export function fileInfoTable(entries: FileEntry[]) {
  return fileInfoRows(entries)
    .map((row) => row.map(escapeTsvCell).join("\t"))
    .join("\n");
}

export function fileInfoCsv(entries: FileEntry[]) {
  return "\ufeff" + fileInfoRows(entries)
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}

export function sha256AuditCsv(records: Sha256AuditRecord[]) {
  const generated = formatFileDateTime(new Date().toISOString(), true);
  const rows = [
    ["side", "generated_at", "name", "path", "type", "size_bytes", "modified_at", "mode", "owner", "sha256"],
    ...records.map((record) => [
      record.side,
      generated,
      record.file.name,
      record.file.path,
      fileTypeLabel(record.file),
      String(record.file.size),
      formatFileDateTime(record.file.modifiedAt, true),
      formatMode(record.file.permissions) || "",
      formatOwner(record.file),
      record.hash
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function sha256AuditJson(records: Sha256AuditRecord[]) {
  const sides = [...new Set(records.map((record) => record.side))];
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sides,
      summary: {
        total: records.length,
        local: records.filter((record) => record.side === "local").length,
        remote: records.filter((record) => record.side === "remote").length,
        bytes: records.reduce((total, record) => total + (record.file.isDir ? 0 : record.file.size), 0)
      },
      records: records.map((record) => ({
        side: record.side,
        sha256: record.hash,
        name: record.file.name,
        path: record.file.path,
        type: fileTypeLabel(record.file),
        fileType: record.file.fileType,
        size: record.file.isDir ? null : record.file.size,
        modifiedAt: record.file.modifiedAt,
        mode: formatMode(record.file.permissions) || null,
        symbolicMode: record.file.permissions == null ? null : formatEntrySymbolicMode(record.file),
        owner: record.file.uid == null && record.file.gid == null ? null : `${record.file.uid ?? ""}:${record.file.gid ?? ""}`,
        uid: record.file.uid ?? null,
        gid: record.file.gid ?? null,
        linkTarget: record.file.linkTarget ?? null
      }))
    },
    null,
    2
  );
}

export function propertiesReportText(
  side: FileSide,
  entries: FileEntry[],
  options: PropertiesReportOptions
) {
  const multiple = entries.length > 1;
  const primary = entries[0];
  const lines = [
    "RustShell Properties",
    `Side: ${side === "local" ? "local" : "remote"}`,
    `Items: ${entries.length}`,
    `Generated: ${formatFileDateTime(new Date().toISOString(), true)}`
  ];
  if (primary && !multiple) {
    lines.push(
      `Name: ${primary.name}`,
      `Path: ${primary.path}`,
      `Type: ${fileTypeLabel(primary)}`,
      `Link target: ${primary.linkTarget ?? "-"}`,
      `Size: ${primary.isDir ? options.stats ? String(options.stats.totalSize) : "-" : String(primary.size)}`,
      `Size label: ${primary.isDir ? options.stats ? formatSize(options.stats.totalSize) : "-" : formatSize(primary.size)}`,
      `Mode: ${formatMode(primary.permissions) || "-"}`,
      `Owner: ${formatOwner(primary)}`,
      `Modified: ${formatFileDateTime(primary.modifiedAt, true)}`
    );
    if (options.stats) {
      lines.push(`Files: ${options.stats.fileCount}`, `Directories: ${options.stats.dirCount}`);
    }
    if (options.checksum) {
      lines.push(`SHA-256: ${options.checksum}`);
    }
  } else {
    lines.push(
      `Draft mode: ${options.mode || "(unchanged)"}`,
      `Draft uid: ${options.uid || "(unchanged)"}`,
      `Draft gid: ${options.gid || "(unchanged)"}`,
      `Draft mtime: ${options.mtime || "(unchanged)"}`,
      `Recursive: ${options.recursive ? "yes" : "no"}`,
      "",
      "Items:",
      ...entries.map(
        (entry) =>
          `- ${entry.path} | ${fileTypeLabel(entry)} | ${formatMode(entry.permissions) || "-"} | ${formatOwner(entry)} | ${
            entry.isDir ? "-" : entry.size
          } | ${formatFileDateTime(entry.modifiedAt, true)}${entry.linkTarget ? ` | -> ${entry.linkTarget}` : ""}`
      )
    );
  }
  return lines.join("\n");
}

export function propertiesReportCsv(side: FileSide, entries: FileEntry[], options: PropertiesReportOptions) {
  const generated = formatFileDateTime(new Date().toISOString(), true);
  const multiple = entries.length > 1;
  const rows = [
    [
      "side",
      "generated_at",
      "selection_count",
      "name",
      "path",
      "type",
      "link_target",
      "mode",
      "owner",
      "uid",
      "gid",
      "size_bytes",
      "modified_at",
      "draft_mode",
      "draft_uid",
      "draft_gid",
      "draft_mtime",
      "recursive",
      "stats_total_size",
      "stats_file_count",
      "stats_dir_count",
      "sha256"
    ],
    ...entries.map((entry, index) => [
      side,
      generated,
      String(entries.length),
      entry.name,
      entry.path,
      fileTypeLabel(entry),
      entry.linkTarget ?? "",
      formatMode(entry.permissions) || "",
      formatOwner(entry),
      entry.uid == null ? "" : String(entry.uid),
      entry.gid == null ? "" : String(entry.gid),
      entry.isDir ? "" : String(entry.size),
      formatFileDateTime(entry.modifiedAt, true),
      options.mode,
      options.uid,
      options.gid,
      options.mtime,
      options.recursive ? "true" : "false",
      !multiple && index === 0 && options.stats ? String(options.stats.totalSize) : "",
      !multiple && index === 0 && options.stats ? String(options.stats.fileCount) : "",
      !multiple && index === 0 && options.stats ? String(options.stats.dirCount) : "",
      !multiple && index === 0 ? options.checksum : ""
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function propertiesReportJson(side: FileSide, entries: FileEntry[], options: PropertiesReportOptions) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      side,
      selectionCount: entries.length,
      draft: {
        mode: options.mode || null,
        uid: options.uid || null,
        gid: options.gid || null,
        mtime: options.mtime || null,
        recursive: options.recursive
      },
      stats: options.stats
        ? {
            totalSize: options.stats.totalSize,
            fileCount: options.stats.fileCount,
            dirCount: options.stats.dirCount
          }
        : null,
      checksum: options.checksum || null,
      items: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: fileTypeLabel(entry),
        fileType: entry.fileType,
        isDir: entry.isDir,
        linkTarget: entry.linkTarget ?? null,
        size: entry.isDir ? null : entry.size,
        modifiedAt: entry.modifiedAt,
        mode: formatMode(entry.permissions) || null,
        symbolicMode: entry.permissions == null ? null : formatEntrySymbolicMode(entry),
        uid: entry.uid ?? null,
        gid: entry.gid ?? null,
        owner: entry.uid == null && entry.gid == null ? null : `${entry.uid ?? ""}:${entry.gid ?? ""}`
      }))
    },
    null,
    2
  );
}

export function deleteConfirmCsv(side: FileSide, entries: FileEntry[]) {
  const rows = [
    ["side", "action", "name", "type", "recursive", "mode", "owner", "size", "modified", "path"],
    ...entries.map((entry) => [
      side,
      "delete",
      entry.name,
      fileTypeLabel(entry),
      entry.isDir ? "true" : "false",
      formatMode(entry.permissions) || "-",
      formatOwner(entry),
      entry.isDir ? "" : String(entry.size),
      formatFileDateTime(entry.modifiedAt, true),
      entry.path
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function deleteConfirmJson(side: FileSide, entries: FileEntry[]) {
  const files = entries.filter((entry) => !entry.isDir);
  const dirs = entries.filter((entry) => entry.isDir);
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      side,
      action: "delete",
      recursiveDirectories: true,
      summary: {
        total: entries.length,
        files: files.length,
        directories: dirs.length,
        bytes: files.reduce((total, entry) => total + entry.size, 0)
      },
      items: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: fileTypeLabel(entry),
        fileType: entry.fileType,
        recursive: entry.isDir,
        isDir: entry.isDir,
        size: entry.isDir ? null : entry.size,
        modifiedAt: entry.modifiedAt,
        mode: formatMode(entry.permissions) || null,
        symbolicMode: entry.permissions == null ? null : formatEntrySymbolicMode(entry),
        uid: entry.uid ?? null,
        gid: entry.gid ?? null,
        owner: entry.uid == null && entry.gid == null ? null : `${entry.uid ?? ""}:${entry.gid ?? ""}`,
        linkTarget: entry.linkTarget ?? null
      }))
    },
    null,
    2
  );
}

export function directoryCompareCsv(
  localFiles: FileEntry[],
  remoteFiles: FileEntry[],
  compare: DirectoryCompare,
  options: { includeSame?: boolean } = {}
) {
  const includeSame = options.includeSame ?? true;
  const localByName = new Map(localFiles.map((file) => [file.name, file]));
  const remoteByName = new Map(remoteFiles.map((file) => [file.name, file]));
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])].filter((name) => {
    if (includeSame) return true;
    const local = localByName.get(name) ?? null;
    const remote = remoteByName.get(name) ?? null;
    const mark = local ? compare.local.get(local.path) : remote ? compare.remote.get(remote.path) : null;
    return Boolean(mark && mark.kind !== "same");
  });
  const rows = [
    [
      "name",
      "status",
      "detail",
      "local_path",
      "remote_path",
      "local_type",
      "remote_type",
      "local_mode",
      "remote_mode",
      "local_owner",
      "remote_owner",
      "local_size",
      "remote_size",
      "local_modified",
      "remote_modified"
    ],
    ...names.map((name) => {
      const local = localByName.get(name) ?? null;
      const remote = remoteByName.get(name) ?? null;
      const mark = local ? compare.local.get(local.path) : remote ? compare.remote.get(remote.path) : null;
      return [
        name,
        mark ? compareKindLabel(mark.kind) : "-",
        mark?.detail ?? "-",
        local?.path ?? "",
        remote?.path ?? "",
        local ? fileTypeLabel(local) : "",
        remote ? fileTypeLabel(remote) : "",
        local ? formatMode(local.permissions) || "-" : "",
        remote ? formatMode(remote.permissions) || "-" : "",
        local ? formatOwner(local) : "",
        remote ? formatOwner(remote) : "",
        local ? (local.isDir ? "-" : String(local.size)) : "",
        remote ? (remote.isDir ? "-" : String(remote.size)) : "",
        local ? formatFileDateTime(local.modifiedAt, true) : "",
        remote ? formatFileDateTime(remote.modifiedAt, true) : ""
      ];
    })
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function directoryCompareJson(
  localRoot: string,
  remoteRoot: string,
  localFiles: FileEntry[],
  remoteFiles: FileEntry[],
  compare: DirectoryCompare
) {
  const localByName = new Map(localFiles.map((file) => [file.name, file]));
  const remoteByName = new Map(remoteFiles.map((file) => [file.name, file]));
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])].sort((left, right) =>
    left.localeCompare(right, "zh-Hans-CN")
  );
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      localRoot,
      remoteRoot,
      summary: compare.summary,
      items: names.map((name) => {
        const local = localByName.get(name) ?? null;
        const remote = remoteByName.get(name) ?? null;
        const mark = local ? compare.local.get(local.path) : remote ? compare.remote.get(remote.path) : null;
        return {
          name,
          status: mark?.kind ?? "different",
          statusLabel: mark ? compareKindLabel(mark.kind) : "-",
          detail: mark?.detail ?? "",
          local: local ? directoryCompareJsonEntry(local) : null,
          remote: remote ? directoryCompareJsonEntry(remote) : null
        };
      })
    },
    null,
    2
  );
}

function directoryCompareJsonEntry(entry: FileEntry) {
  return {
    path: entry.path,
    type: fileTypeLabel(entry),
    fileType: entry.fileType,
    isDir: entry.isDir,
    size: entry.isDir ? null : entry.size,
    modifiedAt: entry.modifiedAt,
    mode: formatMode(entry.permissions) || null,
    owner: entry.uid == null && entry.gid == null ? null : `${entry.uid ?? ""}:${entry.gid ?? ""}`,
    linkTarget: entry.linkTarget ?? null
  };
}

function fileInfoRows(entries: FileEntry[]) {
  return [
    ["name", "type", "mode", "symbolic", "owner", "size", "modified", "path"],
    ...entries.map((entry) => [
      entry.name,
      fileTypeLabel(entry),
      formatMode(entry.permissions) || "-",
      formatEntrySymbolicMode(entry),
      formatOwner(entry),
      entry.isDir ? "-" : String(entry.size),
      formatFileDateTime(entry.modifiedAt, true),
      entry.path
    ])
  ];
}

function escapeTsvCell(value: string) {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function escapeCsvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
