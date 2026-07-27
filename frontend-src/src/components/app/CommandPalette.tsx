import type { AppMenuAction, AppMenuGroup } from "@/components/app/AppMenuBar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "@/components/ui/command";
import type { Snippet } from "@/features/terminal/terminalSnippets";

type CommandPaletteProps = {
  open: boolean;
  menus: AppMenuGroup[];
  snippets: Snippet[];
  canRunSnippet: boolean;
  onRunSnippet: (command: string) => void;
  onManageSnippets: () => void;
  onOpenChange: (open: boolean) => void;
};

type CommandAction = Extract<AppMenuAction, { label: string }>;

export function CommandPalette({
  open,
  menus,
  snippets,
  canRunSnippet,
  onRunSnippet,
  onManageSnippets,
  onOpenChange
}: CommandPaletteProps) {
  const commandGroups = menus.map((menu) => ({
    label: menu.label.replace(/\(.+\)/, ""),
    items: menu.items.filter((item): item is CommandAction => item.type !== "separator")
  }));

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索并执行 RustShell 命令"
      className="sm:max-w-xl"
    >
      <CommandInput placeholder="搜索命令" />
      <CommandList>
        <CommandEmpty>没有匹配的命令</CommandEmpty>
        {snippets.length > 0 && (
          <>
            <CommandGroup heading="快捷命令">
              {snippets.map((snippet) => (
                <CommandItem
                  key={snippet.id}
                  value={`快捷命令 ${snippet.name} ${snippet.command}`}
                  disabled={!canRunSnippet}
                  onSelect={() => {
                    if (!canRunSnippet) return;
                    onOpenChange(false);
                    onRunSnippet(snippet.command);
                  }}
                >
                  <span className="min-w-0 truncate">{snippet.name}</span>
                  <CommandShortcut className="min-w-0 truncate font-mono text-[10.5px] normal-case tracking-normal">
                    {snippet.command}
                  </CommandShortcut>
                </CommandItem>
              ))}
              <CommandItem
                value="快捷命令 管理 管理快捷命令 snippets"
                onSelect={() => {
                  onOpenChange(false);
                  onManageSnippets();
                }}
              >
                <span>管理快捷命令…</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        {commandGroups.map((group) => (
          <CommandGroup key={group.label} heading={group.label}>
            {group.items.map((item) => (
              <CommandItem
                key={`${group.label}-${item.label}`}
                value={`${group.label} ${item.label} ${item.hint ?? ""}`}
                disabled={item.disabled}
                onSelect={() => {
                  if (item.disabled) return;
                  onOpenChange(false);
                  item.onClick();
                }}
              >
                <span>{item.label}</span>
                {item.hint && <CommandShortcut>{item.hint}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
