import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyBuildInfo(packagePath, frontendPath, shaPath) {
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const frontend = JSON.parse(fs.readFileSync(frontendPath, 'utf8'));
  const sha = fs.readFileSync(shaPath, 'utf8').trim().toLowerCase();
  if (!/^(unknown|[a-f0-9]{7,40})$/.test(sha)) throw new Error('Invalid image build SHA');
  for (const value of [manifest.version, frontend.frontendVersion, frontend.backendVersion]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._+-]{1,32}$/.test(value)) throw new Error('Invalid build version');
  }
  if (frontend.frontendVersion !== manifest.version || frontend.backendVersion !== manifest.version) {
    throw new Error('Frontend injection and runtime package versions differ');
  }
  if (frontend.shortSha !== sha.slice(0, 7)) throw new Error('Frontend injection and image SHA differ');
  return { frontendVersion: frontend.frontendVersion, backendVersion: manifest.version, shortSha: frontend.shortSha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.cwd();
    const result = verifyBuildInfo(process.argv[2] || path.join(root, 'package.json'),
      process.argv[3] || path.join(root, 'frontend/dist/build-info.json'),
      process.argv[4] || path.join(root, '.build-sha'));
    console.log('[build-info] verified', JSON.stringify(result));
  } catch (error) {
    console.error('[build-info] verification failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  }
}
