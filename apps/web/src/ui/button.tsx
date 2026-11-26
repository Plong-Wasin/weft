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

type ButtonProps = Omit<React.ComponentProps<typeof ButtonPrimitive>, "ref"> & VariantProps<typeof buttonVariants>;

const legacyVariants = new Set(["primary", "secondary", "ghost", "danger"]);
const legacyVariantStyles = new Set([
  "bg-accent-primary", "hover:bg-accent-primary-hover", "text-on-color", "text-white",
  "bg-danger-primary", "hover:bg-danger-primary-hover", "hover:!bg-danger-primary-hover", "!bg-danger-primary",
  "rounded", "rounded-md", "rounded-lg", "h-10", "min-h-9", "px-3", "py-1", "py-1.5",
  "text-13", "text-14", "font-medium", "disabled:opacity-50", "disabled:cursor-not-allowed",
]);

function inferLegacyVariant(className: string): ButtonProps["variant"] | undefined {
  const classes = className.split(/\s+/);
  return (classes.find((name) => legacyVariants.has(name))
    ?? (classes.includes("bg-accent-primary") || classes.includes("!bg-accent-primary") ? "primary" : undefined)
    ?? (classes.includes("bg-danger-primary") || classes.includes("!bg-danger-primary") ? "danger" : undefined)
    ?? (classes.includes("bg-transparent") ? "ghost" : undefined)) as ButtonProps["variant"] | undefined;
}

function cleanLegacyClassName(className: string, variant: ButtonProps["variant"]) {
  return className.split(/\s+/).filter((name) => !legacyVariants.has(name) && !(variant && legacyVariantStyles.has(name))).join(" ");
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, type = "submit", ...props }, ref) {
  // Infer the old class-based variant while call sites are converted to the prop API.
  const classNameText = typeof className === "string" ? className : "";
  const resolvedVariant = variant ?? inferLegacyVariant(classNameText) ?? "secondary";
  const mergedClassName = typeof className === "function"
    ? (state: ButtonPrimitive.State) => {
      const source = className(state) ?? "";
      const activeVariant = variant ?? inferLegacyVariant(source) ?? "secondary";
      return cn(buttonVariants({ variant: activeVariant, size }), touchTarget, cleanLegacyClassName(source, activeVariant));
    }
    : cn(buttonVariants({ variant: resolvedVariant, size }), touchTarget, cleanLegacyClassName(classNameText, resolvedVariant));

  return <ButtonPrimitive ref={ref} data-slot="button" className={mergedClassName} type={type} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };
