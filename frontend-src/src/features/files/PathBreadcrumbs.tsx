import { Fragment, useMemo } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PathBreadcrumb = {
  label: string;
  path: string;
};

type PathBreadcrumbsProps = {
  path: string;
  title: string;
  onPath: (path: string) => void;
};

export function PathBreadcrumbs({ path, title, onPath }: PathBreadcrumbsProps) {
  const breadcrumbs = useMemo(() => buildPathBreadcrumbs(path), [path]);
  if (breadcrumbs.length <= 1) return null;

  return (
    <div className="-mt-px mb-[5px] flex min-h-[26px] min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden" aria-label={`${title} path navigation`}>
      {breadcrumbs.map((crumb, index) => {
        const isCurrent = index === breadcrumbs.length - 1;
        return (
          <Fragment key={`${crumb.path}-${index}`}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("h-6 min-w-0 max-w-[140px] flex-[0_1_auto] rounded-md px-1.5 text-[11px] font-medium text-muted-foreground", isCurrent && "bg-muted text-foreground")}
              title={crumb.path}
              aria-current={isCurrent ? "page" : undefined}
              onClick={() => {
                if (!isCurrent) onPath(crumb.path);
              }}
            >
              <span className="min-w-0 truncate">{crumb.label}</span>
            </Button>
            {!isCurrent && <ChevronRight className="shrink-0 text-muted-foreground opacity-70" size={12} aria-hidden="true" />}
          </Fragment>
        );
      })}
    </div>
  );
}

export function buildPathBreadcrumbs(path: string): PathBreadcrumb[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  return trimmed.includes("\\") ? buildWindowsPathBreadcrumbs(trimmed) : buildPosixPathBreadcrumbs(trimmed);
}

function buildWindowsPathBreadcrumbs(path: string): PathBreadcrumb[] {
  const normalized = path.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    if (parts.length === 0) return [{ label: "\\\\", path: "\\\\" }];
    if (parts.length === 1) return [{ label: `\\\\${parts[0]}`, path: `\\\\${parts[0]}` }];

    const crumbs: PathBreadcrumb[] = [];
    let current = `\\\\${parts[0]}\\${parts[1]}`;
    crumbs.push({ label: `${parts[0]}\\${parts[1]}`, path: current });
    for (const part of parts.slice(2)) {
      current = `${current}\\${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }

  const driveMatch = normalized.match(/^[A-Za-z]:/);
  const crumbs: PathBreadcrumb[] = [];
  let rest = normalized;
  let current = "";

  if (driveMatch) {
    current = `${driveMatch[0]}\\`;
    crumbs.push({ label: driveMatch[0], path: current });
    rest = normalized.slice(driveMatch[0].length).replace(/^\\+/, "");
  } else if (normalized.startsWith("\\")) {
    current = "\\";
    crumbs.push({ label: "\\", path: current });
    rest = normalized.replace(/^\\+/, "");
  }

  for (const part of rest.split("\\").filter(Boolean)) {
    current = current ? `${current.replace(/\\$/, "")}\\${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs.length > 0 ? crumbs : [{ label: normalized, path: normalized }];
}

function buildPosixPathBreadcrumbs(path: string): PathBreadcrumb[] {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/");
  const crumbs: PathBreadcrumb[] = [];
  let current = "";

  if (absolute) {
    crumbs.push({ label: "/", path: "/" });
  }

  for (const part of normalized.split("/").filter(Boolean)) {
    current = absolute ? `${current}/${part}` : current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs.length > 0 ? crumbs : [{ label: normalized, path: normalized }];
}
