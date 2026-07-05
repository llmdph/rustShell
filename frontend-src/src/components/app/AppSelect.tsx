import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type AppSelectProps<T extends string> = {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
};

export function AppSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = "",
  triggerClassName = ""
}: AppSelectProps<T>) {
  return (
    <div className={cn("relative h-8 min-w-0", className)} onClick={(event) => event.stopPropagation()}>
      <Select value={value} onValueChange={(nextValue) => onChange(nextValue as T)} disabled={disabled}>
        <SelectTrigger
          size="sm"
          className={cn(
            "!h-full w-full min-w-0 rounded-sm border-border/80 bg-input/80 px-2 text-left text-[13px] text-foreground shadow-none hover:border-primary/50 hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring/40",
            triggerClassName
          )}
          aria-label={ariaLabel}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
