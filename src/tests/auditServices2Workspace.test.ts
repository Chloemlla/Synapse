import { workspaceService } from "../services/workspaceService";
import InvitationModel from "../models/invitationModel";
import WorkspaceModel from "../models/workspaceModel";

jest.mock("../models/invitationModel", () => ({ __esModule: true, default: {
  findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
} }));
jest.mock("../models/workspaceModel", () => ({ __esModule: true, default: { findOne: jest.fn(), updateOne: jest.fn() } }));
jest.mock("../utils/userRepository", () => ({ userRepository: {} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));

it("restores the invitation if concurrent joins fill the workspace after its precheck", async () => {
  const invitation = { id: "invite-1", workspaceId: "workspace-1", status: "pending", role: "member", expiresAt: new Date(Date.now() + 60_000) };
  (InvitationModel.findOne as jest.Mock).mockReturnValue({ lean: async () => invitation });
  (InvitationModel.findOneAndUpdate as jest.Mock).mockResolvedValue({ ...invitation, status: "accepted" });
  (InvitationModel.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
  (WorkspaceModel.findOne as jest.Mock).mockReturnValue({ lean: async () => ({ id: "workspace-1", creatorId: "owner", members: [], memberLimit: 1 }) });
  (WorkspaceModel.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 0 });

  await expect(workspaceService.acceptInvitation("invite-1", "user-1")).rejects.toThrow("加入工作空间失败");
  expect(InvitationModel.updateOne).toHaveBeenCalledWith(
    expect.objectContaining({ id: "invite-1", status: "accepted", expiresAt: { $gt: expect.any(Date) } }),
    { $set: { status: "pending" } },
  );
});
