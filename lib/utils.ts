/**
 * Tiny className joiner. We deliberately avoid clsx/tailwind-merge as deps for
 * v1 — keep className overrides additive (layout/spacing), not conflicting with
 * a component's own color/background utilities, since this does not de-dupe.
 */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}
