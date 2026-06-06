import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The LVX wordmark in Cinzel (Roman-inscription capitals). Color and size are
 * set by the caller via className (e.g. "text-2xl text-ink"). Pass href={null}
 * to render a non-linked mark (e.g. inside the footer monogram block).
 */
export function Logo({
  className,
  href = "/",
  ariaLabel = "LVX Homes — home",
}: {
  className?: string;
  href?: string | null;
  ariaLabel?: string;
}) {
  const mark = (
    <span className={cn("font-display leading-none tracking-[0.18em]", className)}>
      LVX
    </span>
  );

  if (href === null) return mark;

  return (
    <Link href={href} aria-label={ariaLabel} className="inline-flex items-center">
      {mark}
    </Link>
  );
}
