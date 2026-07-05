import type { TextFile } from "@/api";

export function editorFileMetadata(file: TextFile): TextFile {
  return { ...file, content: "" };
}
