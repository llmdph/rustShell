import { Fragment } from "react";

import { Checkbox } from "@/components/ui/checkbox";

type PermissionBitHandler = (bit: number, checked: boolean) => void;

const cellClass = "grid min-h-8 place-items-center bg-card text-xs text-foreground";

export function PermissionMatrix({ mode, onBit }: { mode: number; onBit: PermissionBitHandler }) {
  const rows = [
    { label: "用户", bits: [0o400, 0o200, 0o100] },
    { label: "组", bits: [0o040, 0o020, 0o010] },
    { label: "其它", bits: [0o004, 0o002, 0o001] }
  ];
  const columns = ["读", "写", "执行"];
  return (
    <div className="mt-2.5 grid grid-cols-[70px_repeat(3,minmax(0,1fr))] gap-px overflow-hidden rounded-md border bg-border">
      <span className={cellClass} />
      {columns.map((column) => (
        <strong key={column} className={`${cellClass} font-semibold`}>{column}</strong>
      ))}
      {rows.map((row) => (
        <Fragment key={row.label}>
          <strong className={`${cellClass} font-semibold`}>{row.label}</strong>
          {row.bits.map((bit) => (
            <span key={bit} className={cellClass}>
              <Checkbox
                aria-label={`${row.label}${columns[row.bits.indexOf(bit)]}`}
                checked={(mode & bit) === bit}
                onCheckedChange={(checked) => onBit(bit, checked === true)}
              />
            </span>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

export function PermissionSpecials({ mode, onBit }: { mode: number; onBit: PermissionBitHandler }) {
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {[
        { label: "setuid", bit: 0o4000 },
        { label: "setgid", bit: 0o2000 },
        { label: "sticky", bit: 0o1000 }
      ].map(({ label, bit }) => (
        <div key={label} className="inline-flex min-h-7 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs">
          <Checkbox
            checked={(mode & bit) === bit}
            onCheckedChange={(checked) => onBit(bit, checked === true)}
          />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
