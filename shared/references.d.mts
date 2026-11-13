export function referenceSupport(
  provider: { type?: string; supportsEdit?: boolean; editTemplate?: unknown } | undefined,
): { max: number; swap: boolean };
export function validateReferences(
  provider: { type?: string; supportsEdit?: boolean; editTemplate?: unknown } | undefined,
  sourceId: string,
  ids?: string[],
  mode?: string,
): string[];
