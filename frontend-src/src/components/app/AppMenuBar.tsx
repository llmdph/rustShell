import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger
} from "@/components/ui/menubar";

export type AppMenuAction =
  | { type: "separator" }
  | { type?: "action"; label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean };

export type AppMenuGroup = { label: string; items: AppMenuAction[] };

export function AppMenuBar({ menus }: { menus: AppMenuGroup[] }) {
  return (
    <Menubar className="h-auto min-w-0 flex-[0_1_auto] gap-0.5 border-0 bg-transparent p-0 shadow-none" aria-label="应用菜单" onClick={(event) => event.stopPropagation()}>
      {menus.map((menu) => (
        <MenubarMenu key={menu.label}>
          <MenubarTrigger className="h-7 rounded-md px-2 text-xs font-normal text-foreground/85 max-[1180px]:px-1.5 data-[state=open]:text-foreground">{menu.label}</MenubarTrigger>
          <MenubarContent className="w-[190px] min-w-[190px] p-1.5">
            {menu.items.map((item, index) =>
              item.type === "separator" ? (
                <MenubarSeparator key={`separator-${index}`} className="" />
              ) : (
                <MenubarItem
                  key={`${item.label}-${index}`}
                  className="min-h-[30px] gap-3 text-xs"
                  disabled={item.disabled}
                  variant={item.danger ? "destructive" : "default"}
                  onSelect={() => {
                    if (item.disabled) return;
                    item.onClick();
                  }}
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.hint && <MenubarShortcut>{item.hint}</MenubarShortcut>}
                </MenubarItem>
              )
            )}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
