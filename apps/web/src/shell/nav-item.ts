/** The look of one sidebar destination, for NavLink's `className`; `isActive` is the open screen. */
export const itemClass = ({ isActive }: { isActive: boolean }) => `transition-colors flex min-h-9 max-md:min-h-11 pointer-coarse:min-h-11 items-center gap-2 rounded-lg px-3 py-1.5 text-[14px] font-medium ${isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`;
