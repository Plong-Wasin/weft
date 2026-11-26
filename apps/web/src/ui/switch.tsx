import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

type LegacyChange = { target: { checked: boolean } };
type SwitchProps = Omit<SwitchPrimitive.Root.Props, "onChange"> & { onChange?: (event: LegacyChange) => void };

function Switch({ className, onChange, onCheckedChange, ...props }: SwitchProps) {
  return <SwitchPrimitive.Root data-slot="switch" className={cn("peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input shadow-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 data-checked:bg-primary data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50 pointer-coarse:relative pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:bg-transparent pointer-coarse:shadow-none pointer-coarse:data-checked:bg-transparent pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:h-5 pointer-coarse:before:w-9 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:rounded-full pointer-coarse:before:bg-input pointer-coarse:before:content-[''] pointer-coarse:data-checked:before:bg-primary", className)} onCheckedChange={(checked, details) => { onCheckedChange?.(checked, details); onChange?.({ target: { checked } }); }} {...props}>
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-checked:translate-x-4 pointer-coarse:relative pointer-coarse:ml-1" />
  </SwitchPrimitive.Root>;
}

export { Switch };
