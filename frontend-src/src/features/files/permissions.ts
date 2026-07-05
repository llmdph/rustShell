import type { FileEntry } from "@/api";

type PermissionClass = "u" | "g" | "o";
type PermissionLetter = "r" | "w" | "x";

export function formatMode(value?: number | null) {
  if (value == null) return "";
  return formatPermissionInput(value);
}

export function formatPermissionInput(value: number) {
  const mode = value & 0o7777;
  return mode.toString(8).padStart(mode > 0o777 ? 4 : 3, "0");
}

export function formatSymbolicMode(value: number, isDir: boolean) {
  const mode = value & 0o7777;
  const read = (bit: number) => ((mode & bit) === bit ? "r" : "-");
  const write = (bit: number) => ((mode & bit) === bit ? "w" : "-");
  const exec = (bit: number, specialBit?: number, lower = "x", upper = "X") => {
    const executable = (mode & bit) === bit;
    if (specialBit && (mode & specialBit) === specialBit) return executable ? lower : upper;
    return executable ? "x" : "-";
  };
  return [
    isDir ? "d" : "-",
    read(0o400),
    write(0o200),
    exec(0o100, 0o4000, "s", "S"),
    read(0o040),
    write(0o020),
    exec(0o010, 0o2000, "s", "S"),
    read(0o004),
    write(0o002),
    exec(0o001, 0o1000, "t", "T")
  ].join("");
}

export function resolvePermissionMode(value: string, file: FileEntry) {
  const numeric = parsePermissionMode(value);
  if (numeric !== undefined) return numeric;
  const baseMode = file.permissions;
  if (baseMode == null) return undefined;
  return applySymbolicPermissionMode(value, baseMode, file.isDir);
}

function parsePermissionMode(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[0-7]{1,4}$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 8);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 0o7777) return undefined;
  return parsed;
}

function applySymbolicPermissionMode(value: string, baseMode: number, isDir: boolean) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let mode = baseMode & 0o7777;
  for (const rawClause of trimmed.split(",")) {
    const clause = rawClause.trim();
    const match = clause.match(/^([ugoa]*)([+=-])([rwxXstugo]*)$/);
    if (!match) return undefined;
    const who = match[1] || "a";
    const operator = match[2];
    const perms = match[3];
    const classes = expandPermissionClasses(who);
    if (!classes) return undefined;
    if (operator === "=") {
      mode &= ~permissionClassMask(classes);
    }
    const bits = symbolicPermissionBits(perms, classes, mode, isDir);
    if (bits === undefined) return undefined;
    if (operator === "+" || operator === "=") {
      mode |= bits;
    } else {
      mode &= ~bits;
    }
  }
  return mode & 0o7777;
}

function expandPermissionClasses(value: string) {
  const set = new Set<string>();
  for (const part of value) {
    if (part === "a") {
      set.add("u");
      set.add("g");
      set.add("o");
    } else if (part === "u" || part === "g" || part === "o") {
      set.add(part);
    } else {
      return null;
    }
  }
  if (set.size === 0) {
    set.add("u");
    set.add("g");
    set.add("o");
  }
  return [...set] as PermissionClass[];
}

function permissionClassMask(classes: PermissionClass[]) {
  let mask = 0;
  for (const target of classes) {
    if (target === "u") mask |= 0o4700;
    if (target === "g") mask |= 0o2070;
    if (target === "o") mask |= 0o1007;
  }
  return mask;
}

function symbolicPermissionBits(perms: string, classes: PermissionClass[], mode: number, isDir: boolean) {
  let bits = 0;
  for (const perm of perms) {
    if (perm === "r" || perm === "w" || perm === "x" || perm === "X") {
      if (perm === "X" && !isDir && (mode & 0o111) === 0) continue;
      bits |= permissionLetterBits(classes, (perm === "X" ? "x" : perm) as PermissionLetter);
    } else if (perm === "s") {
      if (classes.includes("u")) bits |= 0o4000;
      if (classes.includes("g")) bits |= 0o2000;
    } else if (perm === "t") {
      if (classes.includes("o")) bits |= 0o1000;
    } else if (perm === "u" || perm === "g" || perm === "o") {
      bits |= copyPermissionClassBits(mode, perm, classes);
    } else {
      return undefined;
    }
  }
  return bits;
}

function permissionLetterBits(classes: PermissionClass[], perm: PermissionLetter) {
  const table: Record<PermissionLetter, Record<PermissionClass, number>> = {
    r: { u: 0o400, g: 0o040, o: 0o004 },
    w: { u: 0o200, g: 0o020, o: 0o002 },
    x: { u: 0o100, g: 0o010, o: 0o001 }
  };
  return classes.reduce((bits, target) => bits | table[perm][target], 0);
}

function copyPermissionClassBits(mode: number, source: PermissionClass, targets: PermissionClass[]) {
  const shiftFrom = source === "u" ? 6 : source === "g" ? 3 : 0;
  const sourceBits = (mode >> shiftFrom) & 0o7;
  return targets.reduce((bits, target) => {
    const shiftTo = target === "u" ? 6 : target === "g" ? 3 : 0;
    return bits | (sourceBits << shiftTo);
  }, 0);
}
