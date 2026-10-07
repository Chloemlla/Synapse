const mockAcquire = jest.fn();
const mockRead = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
jest.mock("../models/authEmailCooldownModel", () => ({
  AuthEmailCooldownModel: {
    findOneAndUpdate: (...args: unknown[]) => ({ lean: () => ({ exec: () => mockAcquire(...args) }) }),
    findById: (...args: unknown[]) => ({ lean: () => ({ exec: () => mockRead(...args) }) }),
    updateOne: (...args: unknown[]) => ({ exec: () => mockUpdate(...args) }),
    deleteOne: (...args: unknown[]) => ({ exec: () => mockDelete(...args) }),
  },
}));
jest.mock("../utils/logger", () => ({ warn: jest.fn() }));
import { completeAuthEmail, releaseAuthEmail, reserveAuthEmail } from "../services/authEmailCooldownService";

beforeEach(() => {
  jest.resetAllMocks();
  mockAcquire.mockImplementation(async (_query, update) => ({ reservationId: update.$set.reservationId }));
});

it("normalizes recipient identity while isolating different purposes", async () => {
  const first = await reserveAuthEmail(" User@Gmail.com ", "registration");
  const second = await reserveAuthEmail("user@gmail.com", "registration");
  const reset = await reserveAuthEmail("user@gmail.com", "password-reset");
  expect(first.success && second.success && reset.success).toBe(true);
  if (!first.success || !second.success || !reset.success) throw new Error("Expected reservations");
  expect(first.reservation.key).toBe(second.reservation.key);
  expect(first.reservation.key).not.toBe(reset.reservation.key);
  expect(first.reservation.id).not.toBe(second.reservation.id);
  expect(mockAcquire).toHaveBeenCalledWith(
    expect.objectContaining({ expiresAt: { $lte: expect.any(Date) } }),
    expect.any(Object), expect.objectContaining({ upsert: true }),
  );
});

it("returns retry metadata when another request owns the atomic reservation", async () => {
  mockAcquire.mockRejectedValue({ code: 11000 });
  mockRead.mockResolvedValue({ expiresAt: new Date(Date.now() + 30_000) });
  const result = await reserveAuthEmail("user@gmail.com", "registration");
  expect(result).toEqual({ success: false, retryAfterSeconds: expect.any(Number) });
  if (result.success) throw new Error("Expected cooldown");
  expect(result.retryAfterSeconds).toBeGreaterThan(0);
  expect(result.retryAfterSeconds).toBeLessThanOrEqual(30);
});

it("does not disguise database failures as a daily quota or cooldown", async () => {
  mockAcquire.mockRejectedValue(new Error("offline"));
  await expect(reserveAuthEmail("user@gmail.com", "registration")).rejects.toThrow("offline");
});

it("completes and releases only the owned reservation", async () => {
  const reservation = { key: "digest", id: "owner", cooldownMs: 60_000 };
  await completeAuthEmail(reservation);
  await releaseAuthEmail(reservation);
  expect(mockUpdate).toHaveBeenCalledWith({ _id: "digest", reservationId: "owner" }, { $set: { expiresAt: expect.any(Date) } });
  expect(mockDelete).toHaveBeenCalledWith({ _id: "digest", reservationId: "owner" });
});
