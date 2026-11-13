const swaggerJSDoc = require('swagger-jsdoc');
const fs = require('fs');
const path = require('path');

// glob 在所有平台都把 `\` 当转义符，所以 path.join 拼出的 Windows 路径会 0 命中，
// 生成一份 paths 为空的 openapi.json。glob 模式必须始终用正斜杠。
const projectRoot = process.cwd().split(path.sep).join('/');

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Synapse API 文档',
      version: '1.0.0',
      description: '基于 OpenAPI 3.0 的接口文档'
    }
  },
  apis: [
    `${projectRoot}/src/routes/**/*.ts`,
    `${projectRoot}/dist/routes/**/*.js`
  ],
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

// 零命中绝不出货：swagger-jsdoc 对「一个文件都没扫到」不报错，只是吐出一份
// paths 为空的 spec。历史上这条静默通路让镜像带上了 205 字节的空 openapi.json，
// 线上 /api/openapi.json 把空清单发给前端，API 文档页只能渲染一张空白页，
// 而 Docker build 全绿。最常见的成因是 glob 被 pnpm override 解到与 glob 自身
// 不兼容的 minimatch（见 pnpm-workspace.yaml 的 minimatch 说明）。
const pathCount = Object.keys(swaggerSpec.paths || {}).length;
if (pathCount === 0) {
  console.error(
    'openapi.json generation matched zero paths — refusing to write an empty spec.\n' +
    '  apis glob: ' + swaggerOptions.apis.join(' | ') + '\n' +
    '  先自查 glob 是否还能列出路由源文件：\n' +
    '  node -e "const {createRequire}=require(\"module\");' +
    'const rq=createRequire(require.resolve(\"swagger-jsdoc\"));' +
    'console.log(rq(\"glob\").sync(\"<cwd>/src/routes/**/*.ts\").length)"\n' +
    '  返回 0 就是 glob 与 minimatch 版本不匹配（glob@11 需要 minimatch <11）。'
  );
  process.exit(1);
}

fs.writeFileSync(
  path.join(process.cwd(), 'openapi.json'),
  JSON.stringify(swaggerSpec, null, 2),
  'utf-8'
);

console.log(`openapi.json has been generated (${pathCount} paths).`);
