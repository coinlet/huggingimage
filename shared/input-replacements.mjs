// Workbench replacements are draft inputs. Existing media and completed jobs
// keep their original IDs; the replacement ID is sent with the next edit.
export function replacementSlotId(replacements, imageId) {
  return Object.keys(replacements).find((id) => replacements[id].id === imageId) || imageId;
}

export function applyInputReplacements(items, replacements) {
  const seen = new Set();
  return items.flatMap((original) => {
    const replacement = replacements[original.id];
    const image = replacement
      ? {
          ...replacement,
          threadId: original.threadId,
          referenceContext: original.referenceContext,
          referenceInput: original.referenceInput
            ? { ...original.referenceInput, catalogId: "", variant: "replacement" }
            : undefined,
        }
      : original;
    if (seen.has(image.id)) return [];
    seen.add(image.id);
    return [image];
  });
}
