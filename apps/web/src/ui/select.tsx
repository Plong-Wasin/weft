import { Select as SelectPrimitive } from "@base-ui/react/select";
import React from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

/** The modal a Select sits in, so its popup portals into that top layer instead of the inert `<body>`. */
const SelectContainerContext = React.createContext<HTMLElement | undefined>(undefined);
const modalSelector = 'dialog, [data-slot="dialog-content"], [data-create-modal]';

function Select(props: SelectPrimitive.Root.Props<string, false>) {
  const root = React.useRef<HTMLSpanElement>(null);
  const [container, setContainer] = React.useState<HTMLElement | undefined>(undefined);
  // `dialog`, not `dialog[open]`: a parent calls showModal() in its own effect, which runs after this one.
  // Found after mount, never from a ref during render: the first render has no DOM yet, and the popup would then portal
  // to <body>, under a showModal() dialog, until something else happened to re-render it.
  React.useLayoutEffect(() => { setContainer(root.current?.closest<HTMLElement>(modalSelector) ?? undefined); }, []);
  return <SelectContainerContext.Provider value={container}><span ref={root} className="contents" data-slot="select-root"><SelectPrimitive.Root data-slot="select" {...props} /></span></SelectContainerContext.Provider>;
}

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm whitespace-nowrap pointer-coarse:min-h-11 shadow-xs outline-none transition-[border-color,box-shadow] hover:border-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[placeholder]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className)} {...props}>
    {children}<SelectPrimitive.Icon render={<ChevronDown aria-hidden className="size-4 opacity-50" />} />
  </SelectPrimitive.Trigger>;
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn("thai-room min-w-0 truncate", className as string | undefined)} {...props} />;
}

function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
  const container = React.useContext(SelectContainerContext);
  return <SelectPrimitive.Portal container={container}>
    <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50 outline-none">
      <SelectPrimitive.Popup data-slot="select-content" className={cn("relative z-50 max-h-[min(18rem,var(--available-height))] min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:hidden data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className)} {...props}>
        <SelectPrimitive.ScrollUpArrow className="flex h-6 items-center justify-center"><ChevronUp aria-hidden className="size-4" /></SelectPrimitive.ScrollUpArrow>
        <SelectPrimitive.List className="max-h-[min(18rem,var(--available-height))] overflow-y-auto">{children}</SelectPrimitive.List>
        <SelectPrimitive.ScrollDownArrow className="flex h-6 items-center justify-center"><ChevronDown aria-hidden className="size-4" /></SelectPrimitive.ScrollDownArrow>
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>;
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 pointer-coarse:min-h-11", className)} {...props}>
    <span className="absolute right-2 flex size-3.5 items-center justify-center"><SelectPrimitive.ItemIndicator><Check aria-hidden className="size-4" /></SelectPrimitive.ItemIndicator></span>
    {children}
  </SelectPrimitive.Item>;
}

function SelectItemText(props: SelectPrimitive.ItemText.Props) {
  return <SelectPrimitive.ItemText data-slot="select-item-text" {...props} />;
}

export { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue };
