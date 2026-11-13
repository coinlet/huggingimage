import type { ImageItem } from "../src/types";
export function replacementSlotId(replacements: Record<string, ImageItem>, imageId: string): string;
export function applyInputReplacements(
  items: ImageItem[],
  replacements: Record<string, ImageItem>,
): ImageItem[];
