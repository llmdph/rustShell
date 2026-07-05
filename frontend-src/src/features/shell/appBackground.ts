export type AppBackgroundConfig = {
  kind: "none" | "gradient" | "image";
  gradient: string;
  imageData: string;
  dim: number; // 0-85, overlay of --background over the art
  surfaceAlpha: number; // 55-100, panel opacity percentage
};

export const APP_BACKGROUND_EVENT = "rustshell:background-changed";
const STORAGE_KEY = "rustshell.background";

export const backgroundGradients: { id: string; label: string; css: string }[] = [
  { id: "graphite", label: "石墨", css: "linear-gradient(135deg, #18181b 0%, #27272a 45%, #0a0a0a 100%)" },
  { id: "deepsea", label: "深海", css: "linear-gradient(135deg, #020617 0%, #0c4a6e 55%, #020617 100%)" },
  { id: "dusk", label: "暮光", css: "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #831843 100%)" },
  { id: "aurora", label: "极光", css: "linear-gradient(135deg, #022c22 0%, #065f46 40%, #1e3a8a 100%)" }
];

export const defaultAppBackground: AppBackgroundConfig = {
  kind: "none",
  gradient: "graphite",
  imageData: "",
  dim: 35,
  surfaceAlpha: 86
};

export function loadAppBackground(): AppBackgroundConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAppBackground;
    const parsed = JSON.parse(raw) as Partial<AppBackgroundConfig> | null;
    if (!parsed || typeof parsed !== "object") return defaultAppBackground;
    const kind = parsed.kind === "gradient" || parsed.kind === "image" ? parsed.kind : "none";
    return {
      kind,
      gradient: typeof parsed.gradient === "string" ? parsed.gradient : defaultAppBackground.gradient,
      imageData: typeof parsed.imageData === "string" ? parsed.imageData : "",
      dim: clampNumber(Number(parsed.dim), 0, 85, defaultAppBackground.dim),
      surfaceAlpha: clampNumber(Number(parsed.surfaceAlpha), 55, 100, defaultAppBackground.surfaceAlpha)
    };
  } catch {
    return defaultAppBackground;
  }
}

export function saveAppBackground(config: AppBackgroundConfig) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // storage may be full (large image) — caller shows the hint
  }
  window.dispatchEvent(new CustomEvent(APP_BACKGROUND_EVENT));
}

export function backgroundImageValue(config: AppBackgroundConfig): string {
  if (config.kind === "image" && config.imageData) return `url("${config.imageData}")`;
  if (config.kind === "gradient") {
    return backgroundGradients.find((item) => item.id === config.gradient)?.css ?? backgroundGradients[0].css;
  }
  return "none";
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
