module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/integration/**/*.test.js"],
  testTimeout: 45_000,
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
  },
  verbose: true,
};
