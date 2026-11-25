import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

type LegacyChange = { target: { checked: boolean } };
type SwitchProps = Omit<SwitchPrimitive.Root.Props, "onChange"> & { onChange?: (event: LegacyChange) => void };

function Switch({ className, onChange, onCheckedChange, ...props }: SwitchProps) {
  return <SwitchPrimitive.Root data-slot="switch" className={cn("peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input shadow-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 data-checked:bg-primary data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:w-11", className)} onCheckedChange={(checked, details) => { onCheckedChange?.(checked, details); onChange?.({ target: { checked } }); }} {...props}>
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-checked:translate-x-4 pointer-coarse:data-checked:translate-x-5" />
  </SwitchPrimitive.Root>;
}

export { Switch };
