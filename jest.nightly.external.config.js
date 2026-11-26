const baseConfig = require("./jest.config");

module.exports = {
  ...baseConfig,
  testMatch: [
    "<rootDir>/src/tests/ipfs-upload.test.ts",
    "<rootDir>/src/tests/network-apis.test.ts",
    "<rootDir>/src/tests/media-social-life-apis.test.ts",
    "<rootDir>/src/tests/ip-query.test.ts",
    "<rootDir>/src/tests/yiyan-api.test.ts",
    // X4-08：真模型评测。需要 AI_LIVE_EVAL_CHECK=1 且配了聊天 provider，否则整组 skip。
    "<rootDir>/src/tests/aiEvalLive.test.ts",
  ],
  testPathIgnorePatterns: [...(baseConfig.testPathIgnorePatterns ?? [])],
  collectCoverage: false,
  maxWorkers: 1,
  testTimeout: 60_000,
};
