import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverPrimitive.Popup.Props & {
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  container?: HTMLElement | ShadowRoot | React.RefObject<HTMLElement | ShadowRoot | null> | null;
}>(function PopoverContent({ className, align = "start", side = "bottom", sideOffset = 4, container, children, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} collisionPadding={8} className="z-50">
        <PopoverPrimitive.Popup
          ref={ref}
          data-slot="popover-content"
          className={cn("max-h-[min(32rem,var(--available-height))] min-w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none", className)}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
});

export { Popover, PopoverContent, PopoverTrigger };
