import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

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

type OpenRequest = "click" | "keyboard" | null;

export function AppMenuBar({ menus }: { menus: AppMenuGroup[] }) {
  const [openMenu, setOpenMenu] = useState("");
  const openRequestRef = useRef<OpenRequest>(null);

  const menuValue = (menu: AppMenuGroup, index: number) => `${index}:${menu.label}`;

  const closeMenu = () => {
    openRequestRef.current = null;
    setOpenMenu("");
  };

  const handleValueChange = (value: string) => {
    const request = openRequestRef.current;
    openRequestRef.current = null;
    if (!value) {
      setOpenMenu("");
      return;
    }

    setOpenMenu((current) => (current || request === "click" || request === "keyboard" ? value : current));
  };

  const handleTriggerPointerDown = (value: string, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.ctrlKey) return;
    if (openMenu === value) {
      event.preventDefault();
      closeMenu();
      return;
    }
    openRequestRef.current = "click";
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      openRequestRef.current = "keyboard";
    }
  };

  return (
    <Menubar
      value={openMenu}
      onValueChange={handleValueChange}
      className="h-auto min-w-0 flex-[0_1_auto] gap-0.5 border-0 bg-transparent p-0 shadow-none"
      aria-label="Application menu"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {menus.map((menu, menuIndex) => {
        const value = menuValue(menu, menuIndex);
        return (
          <MenubarMenu key={value} value={value}>
            <MenubarTrigger
              className="h-7 rounded-md px-2 text-xs font-normal text-foreground/85 max-[1180px]:px-1.5 data-[state=open]:text-foreground"
              onPointerDown={(event) => handleTriggerPointerDown(value, event)}
              onKeyDown={handleTriggerKeyDown}
            >
              {menu.label}
            </MenubarTrigger>
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
        );
      })}
    </Menubar>
  );
}
