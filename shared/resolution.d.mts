export type SizeSettings = { resolution: string; width: number; height: number };
export const DEFAULT_SIZES: Record<string, [number, number]>;
export function resolveResolution(
  input: { ratio?: string; resolution?: string; width?: number; height?: number },
  providerType?: string,
): SizeSettings & { ratio: string };
