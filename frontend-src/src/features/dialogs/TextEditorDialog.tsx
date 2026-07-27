import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Replace, Save, Search, X } from "lucide-react";

import { InfoRow, Modal } from "@/components/app/DialogPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TextFile } from "@/api";
import type { TextPreviewPosition } from "@/features/dialogs/dialogTypes";
import type { FileSide } from "@/features/files/filePaneTypes";

type TextEditorDialogProps = {
  side: FileSide;
  file: TextFile;
  position: TextPreviewPosition;
  content: string;
  onContent: (content: string) => void;
  onClose: () => void;
  onLoadHead: () => void;
  onLoadTail: () => void;
  onSave: () => void;
};

type TextMatch = {
  start: number;
  end: number;
};

export default function TextEditorDialog({
  side,
  file,
  position,
  content,
  onContent,
  onClose,
  onLoadHead,
  onLoadTail,
  onSave
}: TextEditorDialogProps) {
  const readOnly = file.isBinary || file.truncated;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(-1);
  const matches = useMemo(() => findTextMatches(content, query, caseSensitive), [caseSensitive, content, query]);

  const revealMatch = (index: number, focusEditor = false) => {
    const match = matches[index];
    const textarea = textareaRef.current;
    if (!match || !textarea) return;
    textarea.setSelectionRange(match.start, match.end);
    if (focusEditor) textarea.focus({ preventScroll: true });
  };

  const openSearch = (withReplace: boolean) => {
    const textarea = textareaRef.current;
    const selectedText = textarea?.value.slice(textarea.selectionStart, textarea.selectionEnd) ?? "";
    const selectedQuery = selectedText && !selectedText.includes("\n") && !selectedText.includes("\r") ? selectedText : "";
    setSearchOpen(true);
    setReplaceOpen(withReplace);
    if (selectedQuery) setQuery(selectedQuery);
    requestAnimationFrame(() => {
      const input = withReplace && (selectedQuery || query) ? replaceInputRef.current : findInputRef.current;
      input?.focus();
      input?.select();
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setReplaceOpen(false);
    setCurrentMatch(-1);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const findNext = (reverse = false, focusEditor = false) => {
    if (!query) {
      findInputRef.current?.focus();
      return;
    }
    if (matches.length === 0) {
      setCurrentMatch(-1);
      return;
    }
    const nextIndex = currentMatch < 0
      ? (reverse ? matches.length - 1 : 0)
      : (currentMatch + (reverse ? -1 : 1) + matches.length) % matches.length;
    setCurrentMatch(nextIndex);
    requestAnimationFrame(() => revealMatch(nextIndex, focusEditor));
  };

  const replaceCurrent = () => {
    if (readOnly || !query || matches.length === 0) return;
    const index = currentMatch >= 0 && currentMatch < matches.length ? currentMatch : 0;
    const match = matches[index];
    const nextContent = `${content.slice(0, match.start)}${replacement}${content.slice(match.end)}`;
    const nextMatches = findTextMatches(nextContent, query, caseSensitive);
    const nextIndex = nextMatches.findIndex((item) => item.start >= match.start + replacement.length);
    const normalizedIndex = nextMatches.length === 0 ? -1 : (nextIndex >= 0 ? nextIndex : 0);
    onContent(nextContent);
    setCurrentMatch(normalizedIndex);
    requestAnimationFrame(() => {
      const nextMatch = nextMatches[normalizedIndex];
      if (nextMatch && textareaRef.current) textareaRef.current.setSelectionRange(nextMatch.start, nextMatch.end);
      replaceInputRef.current?.focus();
    });
  };

  const replaceAll = () => {
    if (readOnly || !query || matches.length === 0) return;
    let cursor = 0;
    let nextContent = "";
    for (const match of matches) {
      nextContent += content.slice(cursor, match.start) + replacement;
      cursor = match.end;
    }
    nextContent += content.slice(cursor);
    onContent(nextContent);
    setCurrentMatch(-1);
    requestAnimationFrame(() => replaceInputRef.current?.focus());
  };

  useEffect(() => {
    if (!searchOpen || !query) {
      setCurrentMatch(-1);
      return;
    }
    const nextMatches = findTextMatches(content, query, caseSensitive);
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? 0;
    const nextIndex = nextMatches.findIndex((match) => match.start >= selectionStart);
    const normalizedIndex = nextMatches.length === 0 ? -1 : (nextIndex >= 0 ? nextIndex : 0);
    setCurrentMatch(normalizedIndex);
    requestAnimationFrame(() => {
      const match = nextMatches[normalizedIndex];
      if (match && textareaRef.current) textareaRef.current.setSelectionRange(match.start, match.end);
    });
    // content changes should not pull the cursor away while the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, query, searchOpen]);

  useEffect(() => {
    if (currentMatch >= matches.length) setCurrentMatch(matches.length > 0 ? matches.length - 1 : -1);
  }, [currentMatch, matches.length]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "f") {
        event.preventDefault();
        openSearch(false);
        return;
      }
      if (modifier && key === "h") {
        event.preventDefault();
        openSearch(true);
        return;
      }
      if (modifier && key === "s") {
        event.preventDefault();
        if (!readOnly && !event.repeat) onSave();
        return;
      }
      if (event.key === "F3" && searchOpen) {
        event.preventDefault();
        findNext(event.shiftKey, true);
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }
    };
    document.addEventListener("keydown", onShortcut, true);
    return () => document.removeEventListener("keydown", onShortcut, true);
  });

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || event.key !== "Tab") return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const update = editIndent(content, textarea.selectionStart, textarea.selectionEnd, event.shiftKey);
    onContent(update.content);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(update.selectionStart, update.selectionEnd);
    });
  };

  return (
    <Modal title={side === "local" ? "本地编辑" : "远程编辑"} onClose={onClose} wide>
      <div className="py-1">
        <InfoRow label="路径" value={file.path} />
        <InfoRow label="大小" value={formatDialogSize(file.size)} />
        <InfoRow label="模式" value={readOnly ? `只读预览 / ${position === "tail" ? "末尾" : "开头"}` : "可编辑"} />
      </div>
      {file.truncated && (
        <div className="mb-2 mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">大文件仅加载 1MB 预览</span>
          <Button type="button" variant="outline" size="sm" onClick={onLoadHead} disabled={position === "head"}>
            查看开头
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onLoadTail} disabled={position === "tail"}>
            查看末尾
          </Button>
        </div>
      )}
      {searchOpen && (
        <div className="mb-2 space-y-1.5 rounded-md border bg-muted/30 p-2">
          <div className="flex items-center gap-1.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              ref={findInputRef}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  findNext(event.shiftKey);
                }
              }}
              placeholder="查找"
              aria-label="查找文本"
            />
            <span className="w-14 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
              {matches.length > 0 && currentMatch >= 0 ? `${currentMatch + 1}/${matches.length}` : `0/${matches.length}`}
            </span>
            <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => findNext(true)} title="上一个（Shift+F3）" aria-label="上一个匹配">
              <ChevronUp />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => findNext()} title="下一个（F3）" aria-label="下一个匹配">
              <ChevronDown />
            </Button>
            <Button
              type="button"
              variant={caseSensitive ? "secondary" : "ghost"}
              size="icon"
              className="size-8"
              onClick={() => setCaseSensitive((value) => !value)}
              title="区分大小写"
              aria-label="区分大小写"
              aria-pressed={caseSensitive}
            >
              <CaseSensitive />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-8" onClick={closeSearch} title="关闭（Esc）" aria-label="关闭查找">
              <X />
            </Button>
          </div>
          {replaceOpen && (
            <div className="flex items-center gap-1.5">
              <Replace className="size-4 shrink-0 text-muted-foreground" />
              <Input
                ref={replaceInputRef}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    replaceCurrent();
                  }
                }}
                placeholder="替换为"
                aria-label="替换文本"
                disabled={readOnly}
              />
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={replaceCurrent} disabled={readOnly || matches.length === 0}>
                替换
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={replaceAll} disabled={readOnly || matches.length === 0}>
                全部替换
              </Button>
            </div>
          )}
        </div>
      )}
      <Textarea
        ref={textareaRef}
        data-scroll-container
        className="h-[min(52vh,520px)] min-h-[260px] w-full resize-y p-2.5 font-mono text-[13px] leading-[1.45]"
        value={content}
        onChange={(event) => onContent(event.target.value)}
        onKeyDown={onEditorKeyDown}
        readOnly={readOnly}
        spellCheck={false}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>Ctrl+F 查找</span>
        <span>Ctrl+H 替换</span>
        <span>F3 下一个</span>
        <span>Ctrl+S 保存</span>
        <span>Tab 缩进</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button className="gap-2" onClick={onSave} disabled={readOnly}>
          <Save size={14} /> 保存
        </Button>
      </div>
    </Modal>
  );
}

function findTextMatches(content: string, query: string, caseSensitive: boolean): TextMatch[] {
  if (!query) return [];
  const source = caseSensitive ? content : content.toLocaleLowerCase();
  const target = caseSensitive ? query : query.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let offset = 0;
  while (offset <= source.length - target.length) {
    const start = source.indexOf(target, offset);
    if (start < 0) break;
    matches.push({ start, end: start + query.length });
    offset = start + Math.max(query.length, 1);
  }
  return matches;
}

function editIndent(content: string, selectionStart: number, selectionEnd: number, outdent: boolean) {
  if (selectionStart === selectionEnd && !outdent) {
    return {
      content: `${content.slice(0, selectionStart)}  ${content.slice(selectionEnd)}`,
      selectionStart: selectionStart + 2,
      selectionEnd: selectionStart + 2
    };
  }

  const lineStart = content.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const selectedBlock = content.slice(lineStart, selectionEnd);
  const lines = selectedBlock.split("\n");
  let firstLineDelta = 0;
  let totalDelta = 0;
  const editedLines = lines.map((line, index) => {
    if (!outdent) {
      if (index === 0) firstLineDelta = 2;
      totalDelta += 2;
      return `  ${line}`;
    }
    const removable = line.startsWith("\t") ? 1 : Math.min(2, line.match(/^ */)?.[0].length ?? 0);
    if (index === 0) firstLineDelta = -removable;
    totalDelta -= removable;
    return line.slice(removable);
  });
  const editedBlock = editedLines.join("\n");
  return {
    content: `${content.slice(0, lineStart)}${editedBlock}${content.slice(selectionEnd)}`,
    selectionStart: Math.max(lineStart, selectionStart + firstLineDelta),
    selectionEnd: Math.max(lineStart, selectionEnd + totalDelta)
  };
}

function formatDialogSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
