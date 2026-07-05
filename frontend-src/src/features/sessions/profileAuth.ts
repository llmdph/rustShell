import type { Profile } from "@/api";

export function profileAuthKind(auth: Profile["auth"]) {
  const normalized = normalizeAuthProfile(auth);
  if (normalized === "Password" || normalized === "Agent") return normalized;
  return "KeyFile";
}

export function profileKeyPath(auth: Profile["auth"]) {
  const normalized = normalizeAuthProfile(auth);
  return typeof normalized === "object" && "KeyFile" in normalized ? normalized.KeyFile.path : "";
}

export function authProfileFromKind(kind: string, keyPath: string): Profile["auth"] {
  if (kind === "Agent") return "Agent";
  if (kind === "KeyFile") return { KeyFile: { path: keyPath } };
  return "Password";
}

export function normalizeAuthProfile(auth?: Profile["auth"] | Record<string, unknown> | string | null): Profile["auth"] {
  if (typeof auth === "string") {
    const value = auth.trim().toLowerCase().replace(/[-_\s]/g, "");
    if (value === "agent") return "Agent";
    if (value === "password" || value === "passwordauth") return "Password";
    if (value === "keyfile" || value === "privatekey" || value === "publickey") return { KeyFile: { path: "" } };
  }
  if (auth === "Agent" || auth === "Password") return auth;
  if (typeof auth === "object" && auth && "KeyFile" in auth) {
    const keyFile = (auth as { KeyFile?: { path?: string } }).KeyFile;
    return { KeyFile: { path: keyFile?.path ?? "" } };
  }
  if (typeof auth === "object" && auth) {
    const legacy = auth as { keyFile?: { path?: string }; key_file?: { path?: string }; path?: string };
    if (legacy.keyFile || legacy.key_file || typeof legacy.path === "string") {
      return { KeyFile: { path: legacy.keyFile?.path ?? legacy.key_file?.path ?? legacy.path ?? "" } };
    }
  }
  return "Password";
}
