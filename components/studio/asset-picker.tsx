"use client";

import { AssetLibrary } from "@/components/studio/asset-library";
import type { Asset, AssetKind } from "@/lib/library-client";

/** Modal that surfaces the library filtered to one kind; click an asset to pick it. */
export function AssetPicker({
  kind,
  title,
  onPick,
  onClose,
}: {
  kind: AssetKind;
  title?: string;
  onPick: (a: Asset) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-auto bg-ink/80 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl rounded-xl border border-champagne/30 bg-ink p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="font-display text-sm uppercase tracking-[0.18em] text-paper">
            {title ?? "Select an asset"}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-paper/50 transition-colors hover:text-champagne"
          >
            ✕
          </button>
        </div>
        <AssetLibrary
          lockKind={kind}
          pick={(a) => {
            onPick(a);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
