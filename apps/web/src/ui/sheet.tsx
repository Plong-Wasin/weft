import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetPortal(props: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return <SheetPrimitive.Backdrop data-slot="sheet-overlay" className={cn("fixed inset-0 z-50 bg-black/50", className)} {...props} />;
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("text-foreground text-lg font-semibold", className)} {...props} />;
}

function SheetClose(props: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({ className, children, side = "right", closeLabel, ...props }: SheetPrimitive.Popup.Props & { side?: "left" | "right"; closeLabel: string }) {
  return <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Popup data-slot="sheet-content" className={cn(
      "fixed z-50 flex max-h-dvh flex-col gap-4 overflow-y-auto border bg-background p-6 text-foreground shadow-lg outline-none transition ease-in-out data-starting-style:duration-300 data-ending-style:duration-200",
      side === "left"
        ? "inset-y-0 left-0 w-72 max-w-[85vw] rounded-r-2xl border-r data-starting-style:-translate-x-full data-ending-style:-translate-x-full"
        : "inset-y-0 right-0 w-3/4 max-w-sm rounded-l-2xl border-l data-starting-style:translate-x-full data-ending-style:translate-x-full",
      className,
    )} {...props}>
      {children}
      <SheetClose aria-label={closeLabel} className="absolute right-3 top-3 inline-flex size-11 items-center justify-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <X aria-hidden size={18} />
      </SheetClose>
    </SheetPrimitive.Popup>
  </SheetPortal>;
}

export { Sheet, SheetClose, SheetContent, SheetOverlay, SheetPortal, SheetTitle };
