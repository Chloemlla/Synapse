const mockUsageUser = { id: "u-1", role: "user", dailyUsage: 4, lastUsageDate: "2026-10-07T15:59:59Z" };
jest.mock("../services/mongoService", () => ({ mongoose: jest.requireActual("mongoose") }));
jest.mock("../utils/passwordSecurity", () => ({}));
jest.mock("../utils/userStorageProvider", () => ({ getUserStorageProvider: () => ({ getUserById: async () => mockUsageUser }) }));
jest.mock("../services/emailSender", () => ({}));
jest.mock("../templates/emailTemplates", () => ({}));
jest.mock("../utils/userValidationService", () => ({ userValidationService: {} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { getUserUsageDay } from "../services/userService";
import { userRepository } from "../utils/userRepository";

afterEach(() => jest.useRealTimers());

it("uses Shanghai midnight for the day key regardless of UTC date", () => {
  expect(getUserUsageDay(new Date("2026-10-07T15:59:59Z"))).toBe("2026-10-07");
  expect(getUserUsageDay(new Date("2026-10-07T16:00:00Z"))).toBe("2026-10-08");
});

it("resets remaining usage at Shanghai midnight and keeps it across UTC midnight", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-07T16:00:00Z"));
  expect(await userRepository.getRemainingUsage("u-1")).toBe(5);

  mockUsageUser.lastUsageDate = "2026-10-07T23:59:59Z";
  jest.setSystemTime(new Date("2026-10-08T00:00:01Z"));
  expect(await userRepository.getRemainingUsage("u-1")).toBe(1);
});
