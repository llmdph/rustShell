import { ChevronLeft, ChevronRight, CirclePlus } from "lucide-react";

import type { Profile, ServerStatus } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import { PanelHeader } from "@/components/app/PanelHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ConnectionOverview } from "./ConnectionOverview";
import { SessionTree } from "./SessionTree";

type SessionSidebarProps = {
  collapsed: boolean;
  profiles: Profile[];
  activeProfile: Profile | null;
  search: string;
  serverStatus: ServerStatus | null;
  serverStatusLoading: boolean;
  serverStatusError: string;
  onSearchChange: (value: string) => void;
  onExpand: () => void;
  onCollapse: () => void;
  onNewProfile: () => void;
  onSelectProfile: (profile: Profile) => void;
  onConnectProfile: (profile: Profile) => void;
  onRequestSecret: (profile: Profile) => void;
  onEditProfile: (profile: Profile) => void;
  onCopyCommand: (profile: Profile) => void;
  onDuplicateProfile: (profile: Profile) => void;
  onDeleteProfile: (profile: Profile) => void;
  onPromptText: (title: string) => Promise<string | null>;
  onCreateProfileInGroup: (group: string) => void;
  onDeleteFolder: (group: string) => Promise<boolean>;
  onRefreshServerStatus: () => void;
};

export function SessionSidebar({
  collapsed,
  profiles,
  activeProfile,
  search,
  serverStatus,
  serverStatusLoading,
  serverStatusError,
  onSearchChange,
  onExpand,
  onCollapse,
  onNewProfile,
  onSelectProfile,
  onConnectProfile,
  onRequestSecret,
  onEditProfile,
  onCopyCommand,
  onDuplicateProfile,
  onDeleteProfile,
  onPromptText,
  onCreateProfileInGroup,
  onDeleteFolder,
  onRefreshServerStatus
}: SessionSidebarProps) {
  return (
    <aside
      className={
        collapsed
          ? "app-surface grid min-h-0 min-w-0 overflow-hidden border-r bg-card px-1 py-2 [place-items:start_center]"
          : "app-surface grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-2.5 overflow-hidden border-r bg-card px-2 py-[9px]"
      }
    >
      {collapsed ? (
        <Button type="button" variant="ghost" size="icon" className="h-[30px] w-7 rounded-md border bg-card/60 p-0 hover:bg-accent" title="展开会话管理器" onClick={onExpand}>
          <ChevronRight size={16} />
        </Button>
      ) : (
        <>
          <div className="flex min-h-0 flex-col overflow-hidden">
            <PanelHeader
              title="会话管理器"
              action={
                <div className="flex flex-none items-center gap-1">
                  <IconButton
                    title="新建会话"
                    icon={<CirclePlus size={14} />}
                    className="h-[26px] min-w-[26px] px-0"
                    onClick={onNewProfile}
                  />
                  <IconButton
                    title="收起左侧"
                    icon={<ChevronLeft size={14} />}
                    className="h-[26px] min-w-[26px] px-0"
                    onClick={onCollapse}
                  />
                </div>
              }
            />
            <Input
              className="h-7 w-full rounded px-2 text-xs"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索会话"
            />
            <SessionTree
              profiles={profiles}
              activeProfileId={activeProfile?.id ?? null}
              onSelect={onSelectProfile}
              onConnect={onConnectProfile}
              onSecret={onRequestSecret}
              onEdit={onEditProfile}
              onCopyCommand={onCopyCommand}
              onDuplicate={onDuplicateProfile}
              onDelete={onDeleteProfile}
              onPromptText={onPromptText}
              onCreateProfile={onCreateProfileInGroup}
              onDeleteFolder={onDeleteFolder}
            />
          </div>
          <ConnectionOverview
            profile={activeProfile}
            serverStatus={serverStatus}
            serverStatusLoading={serverStatusLoading}
            serverStatusError={serverStatusError}
            onRefreshServerStatus={onRefreshServerStatus}
          />
        </>
      )}
    </aside>
  );
}
