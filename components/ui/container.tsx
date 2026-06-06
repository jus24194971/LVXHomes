import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Centered content column. Default ~1200px; `narrow` (~720px) for editorial
 * text blocks per the brand's emphasis on readable measure.
 */
export function Container({
  children,
  className,
  narrow = false,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  narrow?: boolean;
  as?: ElementType;
}) {
  return (
    <Tag
      className={cn(
        "mx-auto w-full px-6 sm:px-8",
        narrow ? "max-w-[720px]" : "max-w-[1200px]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
