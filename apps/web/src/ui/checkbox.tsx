import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

type LegacyChange = { target: { checked: boolean } };
type CheckboxProps = Omit<CheckboxPrimitive.Root.Props, "onChange"> & { onChange?: (event: LegacyChange) => void };

function Checkbox({ className, onChange, onCheckedChange, ...props }: CheckboxProps) {
  return <CheckboxPrimitive.Root data-slot="checkbox" className={cn("group peer relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-background shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50 pointer-coarse:size-11", className)} onCheckedChange={(checked, details) => { onCheckedChange?.(checked, details); onChange?.({ target: { checked: checked === true } }); }} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="size-3.5 group-data-indeterminate:hidden" aria-hidden />
      <Minus className="hidden size-3.5 group-data-indeterminate:block" aria-hidden />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}

export { Checkbox };
