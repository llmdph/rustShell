import type { AppMenuAction, AppMenuGroup } from "@/components/app/AppMenuBar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from "@/components/ui/command";

type CommandPaletteProps = {
  open: boolean;
  menus: AppMenuGroup[];
  onOpenChange: (open: boolean) => void;
};

type CommandAction = Extract<AppMenuAction, { label: string }>;

export function CommandPalette({ open, menus, onOpenChange }: CommandPaletteProps) {
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
