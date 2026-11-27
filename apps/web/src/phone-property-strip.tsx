import React from "react";

/** The phone list's one line of property chips. It scrolls sideways, and the edge fades while chips lie beyond it. */
export function PhonePropertyStrip({ children }: { children: React.ReactNode }) {
  const strip = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  const [more, setMore] = React.useState({ before: false, after: false });
  React.useLayoutEffect(() => {
    const element = strip.current;
    if (!element || !content.current) return;
    const update = () => {
      const before = element.scrollLeft > 1;
      const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setMore((current) => current.before === before && current.after === after ? current : { before, after });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(content.current);
    element.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  const mask = more.before || more.after
    ? `linear-gradient(to right, transparent, black ${more.before ? "1.5rem" : "0px"}, black calc(100% - ${more.after ? "1.5rem" : "0px"}), transparent)`
    : undefined;
  return <div ref={strip} data-testid="phone-property-strip" style={{ maskImage: mask }} className="h-11 min-w-0 max-w-full flex-1 scroll-px-6 overflow-x-auto overscroll-x-contain [scrollbar-width:none] sm:hidden">
    <div ref={content} className="flex h-full w-max items-center gap-1">{children}</div>
  </div>;
}
