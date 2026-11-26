import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

type LegacyChange = { target: { checked: boolean } };
/**
 * Touch target on coarse pointers:
 * - "box" (default): the box itself grows to 44px, so stacked checkboxes push each other apart and never share a tap area.
 * - "overlay": the box stays 16px and a transparent 44px ::before answers taps. Only for a checkbox with at least 14px of non-interactive
 *   space on every side (list-row and toolbar checkboxes); in a tight stack the next checkbox's overlay would cover this one.
 */
type CheckboxHitArea = "box" | "overlay";
type CheckboxProps = Omit<CheckboxPrimitive.Root.Props, "onChange"> & { onChange?: (event: LegacyChange) => void; hitArea?: CheckboxHitArea };
const hitAreaClass: Record<CheckboxHitArea, string> = {
  box: "pointer-coarse:size-11",
  overlay: "before:pointer-events-none before:absolute before:inset-1/2 before:size-4 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] pointer-coarse:before:pointer-events-auto pointer-coarse:before:size-11",
};

function Checkbox({ className, onChange, onCheckedChange, hitArea = "box", ...props }: CheckboxProps) {
  return <CheckboxPrimitive.Root data-slot="checkbox" className={cn("group peer relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-background shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50", hitAreaClass[hitArea], className)} onCheckedChange={(checked, details) => { onCheckedChange?.(checked, details); onChange?.({ target: { checked: checked === true } }); }} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="size-3.5 group-data-indeterminate:hidden" aria-hidden />
      <Minus className="hidden size-3.5 group-data-indeterminate:block" aria-hidden />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}

export { Checkbox };
