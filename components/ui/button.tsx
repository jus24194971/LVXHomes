import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "outline" | "solid" | "light";

const BASE =
  "inline-flex items-center justify-center gap-2 font-sans text-[0.8125rem] font-normal uppercase tracking-[0.18em] px-7 py-3.5 transition-colors duration-300";

const VARIANTS: Record<Variant, string> = {
  // The quiet "Inquire" CTA — champagne outline on light backgrounds.
  outline: "border border-champagne text-champagne-dk hover:bg-champagne hover:text-ink",
  // Filled CTA for light sections.
  solid: "bg-ink text-paper hover:bg-espresso",
  // For dark sections: light outline that fills champagne on hover.
  light: "border border-paper/40 text-paper hover:bg-champagne hover:border-champagne hover:text-ink",
};

type ButtonProps = {
  children: ReactNode;
  className?: string;
  variant?: Variant;
  href?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * CTA primitive. Renders a Next <Link> when `href` is set, otherwise a
 * <button>. Letterspaced small-caps for an architectural, restrained feel.
 */
export function Button({
  children,
  className,
  variant = "outline",
  href,
  ...rest
}: ButtonProps) {
  const classes = cn(BASE, VARIANTS[variant], className);
  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
