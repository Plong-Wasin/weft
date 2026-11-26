import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { CalendarDays, ChevronDown } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { Popover } from "../shell/popover";
import { DatePanel } from "../date-picker";
import { shortDay, type DateField, type DateRange, type DayKey } from "../date-picker-logic";

const t = (key: string) => translate(key as MessageKey);

/** A single calendar date in the shared shadcn control style. */
export function DatePicker({ label, value, onChange, field = "start", min, max, disabled, className = "" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  field?: DateField;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
}) {
  const range: DateRange = field === "start" ? { startDate: value || null, dueDate: null } : { startDate: null, dueDate: value || null };
  const shown = value ? shortDay(value) : t("datePicker.noDate");
  // Same box, type and empty-value tone as SelectTrigger, so a date sits beside a Select as one kind of control.
  const trigger = <span data-date-value={value} className="flex min-w-0 w-full items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><CalendarDays aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className={cn("thai-room truncate", !value && "text-muted-foreground")}>{shown}</span></span><ChevronDown aria-hidden className="size-4 shrink-0 opacity-50" /></span>;
  const triggerClass = "h-9 w-full justify-between gap-2 rounded-md border border-input bg-background py-2 text-sm font-normal text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
  if (disabled) return <Button type="button" aria-label={`${label}: ${shown}`} data-date-value={value} disabled className={cn(triggerClass, className)}>{trigger}</Button>;
  return <Popover label={`${label}: ${shown}`} panelRole="dialog" panelClassName="grid w-[22rem] max-w-[calc(100vw-2rem)] gap-2 p-3"
    className={cn(triggerClass, className)} trigger={trigger}>
    {(close) => <div data-date-picker><DatePanel range={range} field={field} single label={label} min={min as DayKey | undefined} max={max as DayKey | undefined}
      onChange={(change) => { const next = field === "start" ? change.startDate : change.dueDate; if (next !== undefined) { onChange(next ?? ""); close(); } }} /></div>}
  </Popover>;
}
