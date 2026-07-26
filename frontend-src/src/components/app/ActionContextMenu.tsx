import { useState, type ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";

export type FileAction =
  | { type: "separator" }
  | { type?: "action"; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean };

type ActionContextMenuProps = {
  /**
   * Pass a getter when this menu is attached to a list row. Callers that build
   * their action list inline can keep passing the array; callers that need a
   * stable prop (so the row can be memoised) pass a stable getter instead, and
   * it is only invoked when the menu opens — so it still sees fresh state.
   */
  actions: FileAction[] | (() => FileAction[]);
  children: ReactNode;
};

export function ActionContextMenu({ actions, children }: ActionContextMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* Content stays mounted so Radix's positioning and presence behaviour is
          unchanged; only the items are built on demand. */}
      <ContextMenuContent className="w-56 max-w-[min(22rem,calc(100vw-1rem))]">
        {open ? <FileContextMenuItems actions={typeof actions === "function" ? actions() : actions} /> : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileContextMenuItems({ actions }: { actions: FileAction[] }) {
  return (
    <>
      {actions.map((action, index) =>
        action.type === "separator" ? (
          <ContextMenuSeparator key={`separator-${index}`} />
        ) : (
          <ContextMenuItem
            key={`${action.label}-${index}`}
            disabled={action.disabled}
            variant={action.danger ? "destructive" : "default"}
            onSelect={() => {
              action.onClick();
            }}
          >
            {action.icon}
            <span className="truncate">{action.label}</span>
          </ContextMenuItem>
        )
      )}
    </>
  );
}
