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
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  description: string;
  members: Array<{ userId: string; role: "admin" | "editor" | "reviewer" | "viewer" }>;
};
