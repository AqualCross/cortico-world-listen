#!/usr/bin/env node
/**
 * 重新生成 describe.json（与框架 `pnpm describe:extension` 对 World 的导出一致）：
 * 仅导出定义中的工具与事件。
 * 跑法：node tools/describe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;
const world = def.create({ cfg: def.defaults(), dataDir: pkgDir, botDir: pkgDir });
const prompts = world.webUi('zh').promptDocs.map((doc) => ({
  key: doc.key, title: doc.title, role: doc.role, content: readFileSync(doc.path, 'utf8'),
}));

const file = {
  tools: [...def.describe.tools],
  events: [...def.describe.events],
  prompts,
};
writeFileSync(join(pkgDir, 'describe.json'), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`describe.json 已写入：${file.tools.length} 个工具，${file.events.length} 个事件。`);
