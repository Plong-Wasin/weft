import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

const DropdownMenuContent = React.forwardRef<HTMLDivElement, MenuPrimitive.Popup.Props & { align?: "start" | "center" | "end"; sideOffset?: number; container?: HTMLElement | ShadowRoot | React.RefObject<HTMLElement | ShadowRoot | null> | null }>(function DropdownMenuContent({ className, align = "start", sideOffset = 4, container, children, ...props }, ref) {
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner align={align} sideOffset={sideOffset} className="z-50">
        <MenuPrimitive.Popup ref={ref} data-slot="dropdown-menu-content" className={cn("max-h-[var(--available-height)] min-w-32 overflow-y-auto overflow-x-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", className)} {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
});

function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="dropdown-menu-item" className={cn("rounded-[var(--radius)] transition-colors duration-[120ms] hover:bg-accent focus-visible:bg-accent flex w-full cursor-default items-center gap-2 px-2.5 py-1.5 text-left text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 pointer-coarse:min-h-11", className)} {...props} />;
}

function DropdownMenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return <MenuPrimitive.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn("rounded-[var(--radius)] transition-colors duration-[120ms] hover:bg-accent focus-visible:bg-accent relative flex w-full cursor-default items-center gap-2 py-1.5 pr-2.5 pl-8 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 pointer-coarse:min-h-11", className)} {...props}>{children}</MenuPrimitive.CheckboxItem>;
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return <MenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" className={cn("rounded-[var(--radius)] transition-colors duration-[120ms] hover:bg-accent focus-visible:bg-accent relative flex w-full cursor-default items-center gap-2 py-1.5 pr-2.5 pl-8 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 pointer-coarse:min-h-11", className)} {...props}>{children}</MenuPrimitive.RadioItem>;
}

function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />;
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger };
