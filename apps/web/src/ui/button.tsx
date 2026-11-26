import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        secondary: "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        danger: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

/** Touch sizing belongs to real buttons only: `buttonVariants` also styles spans and links inside larger targets. */
const touchTarget = "pointer-coarse:min-h-11 pointer-coarse:has-[>svg:only-child]:min-w-11";

// Component classes in style.css that set their own box and colours. Variant and size utilities would override them (utilities beat components).
const selfStyled = /(?:^|\s)(?:attachment-action-button|editor-tool|icon-button-ghost|table-control|wiki-bubble-button|wiki-bubble-reset|wiki-bubble-swatch)(?:\s|$)/;
// A call site that sizes a square button itself (`size-6`) must not keep the default size's height and padding.
const squared = /(?:^|\s)!?size-\d/;
const selfStyledBase = "cursor-pointer disabled:pointer-events-none disabled:opacity-50";

type ButtonProps = Omit<React.ComponentProps<typeof ButtonPrimitive>, "ref"> & VariantProps<typeof buttonVariants>;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, type = "submit", ...props }, ref) {
  const merge = (classes: string | undefined) => !variant && !size && selfStyled.test(classes ?? "")
    ? cn(selfStyledBase, touchTarget, classes)
    : cn(buttonVariants({ variant, size: size ?? (squared.test(classes ?? "") ? null : undefined) }), touchTarget, classes);
  const mergedClassName = typeof className === "function" ? (state: ButtonPrimitive.State) => merge(className(state)) : merge(className);

  return <ButtonPrimitive ref={ref} data-slot="button" className={mergedClassName} type={type} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };
