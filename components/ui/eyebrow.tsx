import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Uppercase, wide-tracked label. Defaults to taupe on light backgrounds; pass
 * className (e.g. text-champagne) when placed on a dark section.
 */
export function Eyebrow({
  children,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  return (
    <Tag
      className={cn(
        "font-sans text-[0.6875rem] font-normal uppercase tracking-[0.24em] text-taupe",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
