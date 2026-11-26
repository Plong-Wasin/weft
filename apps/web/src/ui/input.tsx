import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input({ className, type, ...props }, ref) {
  return <input ref={ref} data-slot="input" type={type} className={cn("flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 read-only:not-disabled:cursor-default read-only:not-disabled:bg-muted read-only:not-disabled:text-muted-foreground read-only:not-disabled:shadow-none md:text-sm pointer-coarse:min-h-11", className)} {...props} />;
});
Input.displayName = "Input";

export { Input };
