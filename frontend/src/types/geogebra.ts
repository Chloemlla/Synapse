// GeoGebra 工作台的领域类型。放在 src/types/ 是仓库既有约定（lottery.ts / tts.ts 同层），
// 让 API 客户端与页面共用同一份形状，避免 api/ 反向依赖 components/。
export type GeoGebraMode = "geometry" | "3d" | "graphing" | "classic";

export type GeoGebraLocalVersion = {
  versionId: string;
  label: string;
  code: string;
  canvasMode: GeoGebraMode;
  trigger: string;
  createdAt: string;
};

export type GeoGebraLocalProject = {
  projectId: string;
  title: string;
  folder: string;
  tags: string[];
  isFavorite: boolean;
  workspaceId: string | null;
  cloudRevision?: number;
  canvasMode: GeoGebraMode;
  code: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  versions: GeoGebraLocalVersion[];
};

export type GeoGebraProject = {
  projectId: string;
  isOwner: boolean;
  workspaceId: string | null;
  title: string;
  folder: string;
  tags: string[];
  isFavorite: boolean;
  canvasMode: GeoGebraMode;
  code: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};

export type GeoGebraVersion = GeoGebraLocalVersion & {
  projectId: string;
};

export type GeoGebraReviewComment = {
  commentId: string;
  projectId: string;
  versionId: string | null;
  objectName: string | null;
  body: string;
  status: "open" | "resolved";
  canResolve: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GeoGebraShare = {
  shareId: string;
  slug: string;
  title: string;
  canvasMode: GeoGebraMode;
  commands: string[];
  coverUrl: string | null;
  allowFork: boolean;
  revokedAt: string | null;
  createdAt: string;
  /** 服务端返回的相对嵌入地址；已撤销/不可嵌入时为 null。 */
  embedUrl: string | null;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  description: string;
  members: Array<{ userId: string; role: "admin" | "editor" | "reviewer" | "viewer"; username?: string | null }>;
};

export type GeoGebraAsset = {
  assetId: string;
  purpose: "ai-reference" | "export-bundle";
  mimeType: string;
  byteSize: number;
  createdAt: string;
  expiresAt: string;
};

export type GeoGebraAiKind = "ai-drawing" | "ai-insight" | "ai-annotation" | "ai-explanation";
export type GeoGebraJobKind = GeoGebraAiKind | "export";
export type GeoGebraJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";

export type GeoGebraJobResult = {
  summary?: string;
  commands?: string[];
  notes?: string[];
  confidence?: number | null;
  assetId?: string;
};

export type GeoGebraJob = {
  jobId: string;
  kind: GeoGebraJobKind;
  status: GeoGebraJobStatus;
  progress: number;
  projectId: string | null;
  result: GeoGebraJobResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GeoGebraExportFormat = "zip-bundle" | "svg" | "pdf" | "gif" | "mp4" | "pptx";

export type GeoGebraExportCapability = {
  format: GeoGebraExportFormat;
  serverSide: boolean;
  note: string;
};
