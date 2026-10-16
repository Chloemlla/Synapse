import type { GeoGebraMode } from "./script";

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
