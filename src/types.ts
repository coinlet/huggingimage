export type Provider = {
  id: string;
  name: string;
  type: "xai" | "openai" | "gradio" | "mcp";
  mcpTransport?: "auto" | "streamable-http" | "sse";
  mcpAuth?: "bearer" | "x-api-key";
  enabled: boolean;
  supportsEdit: boolean;
  supportsGenerate?: boolean;
  editOutputPath?: string;
  defaults?: {
    generate?: { steps?: number; guidance?: number };
    edit?: { steps?: number; guidance?: number };
  };
  hasKey: boolean;
  model: string;
  baseUrl?: string;
  space?: string;
  endpoint?: string;
  editEndpoint?: string;
  template?: unknown;
  editTemplate?: unknown;
  outputPath?: string;
  extra?: Record<string, unknown>;
};
export type ImageItem = {
  id: string;
  url: string;
  thumbnail: string;
  prompt: string;
  createdAt: string;
  width: number;
  height: number;
  favorite: boolean;
  status?: "submitting" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: string;
  localDraft?: boolean;
  providerName?: string;
  model?: string;
  mode?: string;
  seed?: number;
  kind?: "upload" | "generated";
  threadId?: string;
  parentId?: string;
  jobId?: string;
  versionCount?: number;
  groupUpdatedAt?: string;
  example?: boolean;
  category?: string;
  name?: string;
};
export type Job = {
  referenceIds?: string[];
  referenceMode?: "reference" | "swap";
  id: string;
  sourceId?: string;
  slotIds?: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  prompt: string;
  providerName: string;
  createdAt: string;
  completedAt?: string;
  mode: string;
  error?: string;
  imageIds: string[];
  count: number;
  ratio: string;
  resolution?: string;
  width?: number;
  height?: number;
};
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const result = await res.json();
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new Error(result.error || `请求失败：${res.status}`);
  }
  return result;
}
export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

export type SpaceDiscovery = {
  source: "schema" | "ai";
  ready: boolean;
  aiAvailable: boolean;
  name: string;
  space: string;
  supportsGenerate: boolean;
  supportsEdit: boolean;
  endpoint: string;
  editEndpoint: string;
  template: unknown;
  editTemplate: unknown;
  outputPath: string;
  editOutputPath: string;
  defaults: Provider["defaults"];
  warnings: string[];
  candidates: Array<{
    endpoint: string;
    canGenerate: boolean;
    canEdit: boolean;
    outputPath: string;
    missing: string[];
    template: unknown;
  }>;
};

export type CreationInput = {
  referenceIds?: string[];
  referenceMode?: "reference" | "swap";
  resolution?: string;
  width?: number;
  height?: number;
  providerId: string;
  prompt: string;
  mode: "generate" | "edit";
  sourceId?: string;
  maskId?: string;
  ratio: string;
  count: number;
  negativePrompt: string;
  seed: string;
  steps: number;
  guidance: number;
  slotIds?: string[];
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  template: Record<string, unknown>;
  generateTemplate: Record<string, unknown>;
  defaults: { steps?: number; guidance?: number };
  missing: string[];
  canGenerate: boolean;
  canEdit: boolean;
};
export type McpDiscovery = {
  defaults?: Provider["defaults"];
  transport: string;
  tools: McpTool[];
  endpoint: string;
  editEndpoint: string;
  template: unknown;
  editTemplate: unknown;
  supportsGenerate: boolean;
  supportsEdit: boolean;
};

export type CreationSettings = {
  referenceIds?: string[];
  referenceMode?: "reference" | "swap";
  ratio: string;
  count: number;
  negativePrompt: string;
  seed: string;
  steps: number;
  guidance: number;
  maskId?: string;
};

export type AssetLibrary = {
  id: string;
  name: string;
  type: "local" | "s3" | "webdav";
  isDefault: boolean;
  hasCredentials: boolean;
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  pathStyle?: boolean;
};
export type AssetEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt?: string;
  image: boolean;
  previewUrl?: string | null;
};
export type AssetListing = { path: string; entries: AssetEntry[]; nextCursor: string | null };
