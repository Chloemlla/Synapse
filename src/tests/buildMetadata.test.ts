import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/verify-build-info.mjs");
const sha = "abc1234" + "b".repeat(33);
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-build-metadata-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function run(version = "26.10.25", frontendVersion = "26.10.25", backendVersion = "26.10.25", shortSha = "abc1234") {
  const manifest = path.join(directory, "package.json");
  const frontend = path.join(directory, "build-info.json");
  const imageSha = path.join(directory, ".build-sha");
  fs.writeFileSync(manifest, JSON.stringify({ version }));
  fs.writeFileSync(frontend, JSON.stringify({ frontendVersion, backendVersion, shortSha }));
  fs.writeFileSync(imageSha, sha);
  return spawnSync(process.execPath, [script, manifest, frontend, imageSha], { encoding: "utf8", timeout: 5000 });
}
it("accepts matching runtime manifest, frontend injection and image SHA", () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"backendVersion":"26.10.25"');
  expect(result.stdout).toContain('"shortSha":"abc1234"');
});
it.each([
  ["26.10.17", "26.10.25", "26.10.25"],
  ["26.10.25", "26.10.17", "26.10.25"],
  ["26.10.25", "26.10.25", "26.10.17"],
])("rejects stale runtime or mismatched injection %s/%s/%s", (runtime, frontend, injectedBackend) => {
  const result = run(runtime, frontend, injectedBackend);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("runtime package versions differ");
});
it("rejects an old frontend SHA rather than replacing it with runtime SHA", () => {
  const result = run("26.10.25", "26.10.25", "26.10.25", "fffffff");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("image SHA differ");
});
it("does not pretend missing metadata is success", () => {
  const result = spawnSync(process.execPath, [script, path.join(directory, "missing.json")], { encoding: "utf8", timeout: 5000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("verification failed");
});
it("copies the built runtime manifest after dependency installation and checks image artifacts", () => {
  const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const runtime = docker.slice(docker.indexOf("# Stage 3:"));
  const copy = runtime.indexOf("COPY --from=backend-builder /app/package.json ./package.json");
  expect(copy).toBeGreaterThan(runtime.indexOf("RUN pnpm install --prod"));
  expect(runtime.slice(copy)).not.toMatch(/COPY package\.json/);
  const verify = runtime.indexOf("RUN node scripts/verify-build-info.mjs");
  expect(verify).toBeGreaterThan(runtime.indexOf("COPY --from=frontend-builder /app/frontend/dist"));
  expect(verify).toBeGreaterThan(runtime.indexOf("/app/.build-sha"));
  expect(verify).toBeLessThan(runtime.indexOf("USER nodejs"));
  const vite = fs.readFileSync(path.join(root, "frontend/vite.config.ts"), "utf8");
  expect(vite).toMatch(/__FRONTEND_VERSION__:\s*JSON\.stringify\(FRONTEND_VERSION\)/);
  expect(vite).toMatch(/__BACKEND_VERSION__:\s*JSON\.stringify\(BACKEND_VERSION\)/);
  expect(vite).toMatch(/__GIT_SHORT_SHA__:\s*JSON\.stringify\(GIT_SHORT_SHA\)/);
  expect(vite).toContain('fileName: "build-info.json"');
});
