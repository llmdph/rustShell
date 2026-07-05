import type { ReactNode } from "react";

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
  actions: FileAction[];
  children: ReactNode;
};

export function ActionContextMenu({ actions, children }: ActionContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <FileContextMenu actions={actions} />
    </ContextMenu>
  );
}

function FileContextMenu({ actions }: { actions: FileAction[] }) {
  return (
    <ContextMenuContent className="w-56 max-w-[min(22rem,calc(100vw-1rem))]">
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
    </ContextMenuContent>
  );
}
