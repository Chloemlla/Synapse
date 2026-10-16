import { api } from "../../api/api";
import type { GeoGebraProject, GeoGebraReviewComment, GeoGebraShare, GeoGebraVersion, WorkspaceSummary } from "./types";
import type { GeoGebraMode } from "./script";

type Envelope<T> = { success: boolean; data: T };

function data<T>(response: { data: Envelope<T> }): T {
  if (!response.data?.success) throw new Error("请求暂时无法完成，请稍后重试。");
  return response.data.data;
}

export async function listGeoGebraProjects(): Promise<GeoGebraProject[]> {
  return data(await api.get<Envelope<{ projects: GeoGebraProject[] }>>("/api/geogebra/projects")).projects;
}

export async function getGeoGebraProject(projectId: string): Promise<GeoGebraProject> {
  return data(await api.get<Envelope<{ project: GeoGebraProject }>>(`/api/geogebra/projects/${encodeURIComponent(projectId)}`)).project;
}

export async function createGeoGebraProject(input: {
  projectId?: string;
  title: string;
  folder?: string;
  tags?: string[];
  isFavorite?: boolean;
  canvasMode: GeoGebraMode;
  code: string;
  workspaceId?: string | null;
}): Promise<GeoGebraProject> {
  return data(await api.post<Envelope<{ project: GeoGebraProject }>>("/api/geogebra/projects", input)).project;
}

export async function updateGeoGebraProject(projectId: string, input: Partial<GeoGebraProject> & { revision: number }): Promise<GeoGebraProject> {
  return data(await api.patch<Envelope<{ project: GeoGebraProject }>>(`/api/geogebra/projects/${encodeURIComponent(projectId)}`, input)).project;
}

export async function deleteGeoGebraProject(projectId: string): Promise<void> {
  data(await api.delete<Envelope<{ deleted: boolean }>>(`/api/geogebra/projects/${encodeURIComponent(projectId)}`));
}

export async function listGeoGebraVersions(projectId: string): Promise<GeoGebraVersion[]> {
  return data(await api.get<Envelope<{ versions: GeoGebraVersion[] }>>(`/api/geogebra/projects/${encodeURIComponent(projectId)}/versions`)).versions;
}

export async function createGeoGebraVersion(projectId: string, input: {
  label: string;
  code: string;
  canvasMode: GeoGebraMode;
  trigger: string;
}): Promise<GeoGebraVersion> {
  return data(await api.post<Envelope<{ version: GeoGebraVersion }>>(`/api/geogebra/projects/${encodeURIComponent(projectId)}/versions`, input)).version;
}

export async function listGeoGebraComments(projectId: string): Promise<GeoGebraReviewComment[]> {
  return data(await api.get<Envelope<{ comments: GeoGebraReviewComment[] }>>("/api/geogebra/review-comments", { params: { projectId } })).comments;
}

export async function createGeoGebraComment(input: {
  projectId: string;
  versionId?: string | null;
  objectName?: string | null;
  body: string;
}): Promise<GeoGebraReviewComment> {
  return data(await api.post<Envelope<{ comment: GeoGebraReviewComment }>>("/api/geogebra/review-comments", input)).comment;
}

export async function resolveGeoGebraComment(commentId: string): Promise<GeoGebraReviewComment> {
  return data(await api.patch<Envelope<{ comment: GeoGebraReviewComment }>>(`/api/geogebra/review-comments/${encodeURIComponent(commentId)}`, { status: "resolved" })).comment;
}

export async function listGeoGebraShares(): Promise<GeoGebraShare[]> {
  return data(await api.get<Envelope<{ shares: GeoGebraShare[] }>>("/api/geogebra/shares")).shares;
}

export async function createGeoGebraShare(input: {
  projectId?: string | null;
  title: string;
  canvasMode: GeoGebraMode;
  commands: string[];
  coverDataUrl?: string | null;
  allowFork?: boolean;
}): Promise<GeoGebraShare> {
  return data(await api.post<Envelope<{ share: GeoGebraShare }>>("/api/geogebra/shares", input)).share;
}

export async function getGeoGebraShare(slug: string): Promise<GeoGebraShare> {
  return data(await api.get<Envelope<{ share: GeoGebraShare }>>(`/api/geogebra/shares/${encodeURIComponent(slug)}`)).share;
}

export async function forkGeoGebraShare(slug: string): Promise<GeoGebraProject> {
  return data(await api.post<Envelope<{ project: GeoGebraProject }>>(`/api/geogebra/shares/${encodeURIComponent(slug)}/fork`)).project;
}

export async function deleteGeoGebraShare(shareId: string): Promise<void> {
  data(await api.delete<Envelope<{ deleted: boolean }>>(`/api/geogebra/shares/${encodeURIComponent(shareId)}`));
}

export async function exportGeoGebraData(): Promise<Blob> {
  const response = await api.get<Blob>("/api/geogebra/export", { responseType: "blob" });
  return response.data;
}

export async function listUserWorkspaces(): Promise<WorkspaceSummary[]> {
  const response = await api.get<{ success: boolean; data: WorkspaceSummary[] }>("/api/workspaces");
  return response.data.data;
}

export async function createUserWorkspace(input: { name: string; description?: string }): Promise<WorkspaceSummary> {
  const response = await api.post<{ success: boolean; data: WorkspaceSummary }>("/api/workspaces", input);
  return response.data.data;
}

export async function inviteWorkspaceMember(workspaceId: string, input: { email: string; role: "editor" | "reviewer" | "viewer" }): Promise<void> {
  await api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/invite`, input);
}
