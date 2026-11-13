export type GalleryKind = "portrait" | "costume" | "pose";
export type GalleryImage = { id: string; label: string; url: string; thumbnail: string };
export type GalleryItem = {
  id: string;
  kind: GalleryKind;
  title: string;
  category: string;
  source: string;
  sourceLabel: string;
  sourceUrl: string;
  sensitive: boolean;
  search: string;
  system: string;
  angle: string;
  group: string;
  hair: string;
  partition: string;
  featured: boolean;
  popular: boolean;
  tags: string[];
  variants: GalleryImage[];
  depth?: GalleryImage;
};
export type GallerySelection = { id: string; variant: string; depth: boolean };
export type GalleryRecipe = Record<GalleryKind, GallerySelection | null> & {
  style: string;
  notes: string;
  safeMode: boolean;
  locked: GalleryKind[];
};
export const STYLE_PRESETS: Record<string, { label: string; prompt: string }>;
export const RECIPE_SLOTS: GalleryKind[];
export const SLOT_LABELS: Record<GalleryKind, string>;
export function emptyGalleryRecipe(): GalleryRecipe;
export function recipeReferences(
  recipe: GalleryRecipe,
  items: GalleryItem[] | Map<string, GalleryItem>,
): Array<{
  slot: GalleryKind;
  item: GalleryItem;
  selection: GallerySelection;
  image: GalleryImage;
  number: number;
}>;
export function buildGalleryPrompt(
  recipe: GalleryRecipe,
  items: GalleryItem[] | Map<string, GalleryItem>,
): string;
export function randomGalleryRecipe(
  recipe: GalleryRecipe,
  items: GalleryItem[],
  random?: () => number,
  onlySlot?: GalleryKind,
): GalleryRecipe;
