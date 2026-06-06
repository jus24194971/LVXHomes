import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "paper" | "card" | "sand" | "espresso" | "ink";
type Spacing = "tight" | "normal" | "loose";

const TONE: Record<Tone, string> = {
  paper: "bg-paper text-ink",
  card: "bg-card text-ink",
  sand: "bg-sand text-ink",
  espresso: "bg-espresso text-paper",
  ink: "bg-ink text-paper",
};

const SPACING: Record<Spacing, string> = {
  tight: "py-16 sm:py-20",
  normal: "py-24 sm:py-32",
  loose: "py-32 sm:py-44",
};

/**
 * Full-width band with generous vertical rhythm. `dark` is shorthand for the
 * espresso tone used around video so reels read cinematically.
 */
export function Section({
  children,
  className,
  id,
  tone,
  dark = false,
  spacing = "normal",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  tone?: Tone;
  dark?: boolean;
  spacing?: Spacing;
}) {
  const resolved: Tone = tone ?? (dark ? "espresso" : "paper");
  return (
    <section id={id} className={cn(TONE[resolved], SPACING[spacing], className)}>
      {children}
    </section>
  );
}
