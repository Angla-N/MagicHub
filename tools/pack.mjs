/**
 * MagicHub 一键打包（客户端 / 服务端）
 *
 * 解决两类历史问题：
 *  1. 打包时漏带 7za.exe / brand，导致插件市场下载、图标缺失 —— 这里统一自动带入
 *  2. Windows 上临时目录默认在 C 盘，rename 到 F 盘产物目录会报 EPERM —— 临时目录固定放仓库内
 *
 * 用法：
 *   node tools/pack.mjs             # 打包客户端 + 服务端
 *   node tools/pack.mjs client      # 只打包客户端
 *   node tools/pack.mjs server      # 只打包服务端
 *   node tools/pack.mjs client --out=dist/xxx
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith("--"));
const outArg = args.find((a) => a.startsWith("--out="));
const outDir = outArg ? resolve(root, outArg.slice("--out=".length)) : join(root, "dist");

const jobs = {
  client: {
    appDir: join(root, "apps", "desktop"),
    name: "MagicHub-Client",
    resources: ["apps/web", "brand", "tools/7za.exe"],
  },
  server: {
    appDir: join(root, "apps", "server-app"),
    name: "MagicHub-Server",
    resources: ["apps/server", "plugins", "brand", "tools/7za.exe"],
  },
};

const wanted = targets.length === 0 || targets.includes("all") ? Object.keys(jobs) : targets;

function fail(message) {
  console.error("[pack] " + message);
  process.exit(1);
}

for (const key of wanted) {
  if (!jobs[key]) fail(`未知打包目标「${key}」，可用：client / server / all`);
}

// 自动带入的公共资源必须先存在，缺任何一个都直接报错，避免产出不可用包
const iconPath = join(root, "brand", "icon.ico");
if (!existsSync(iconPath)) fail("缺少程序图标 brand/icon.ico");
if (!existsSync(join(root, "tools", "7za.exe"))) {
  fail("缺少 tools/7za.exe（插件市场解压/打包依赖），请把它放回 tools/ 目录");
}

// 临时目录固定在仓库内（同盘 rename），避免 C 盘 → 产物盘 的 EPERM
const tmpDir = join(root, ".tmp-pack");
mkdirSync(tmpDir, { recursive: true });

let failed = false;
for (const key of wanted) {
  const job = jobs[key];
  const packager = join(job.appDir, "node_modules", "electron-packager", "bin", "electron-packager.js");
  if (!existsSync(packager)) fail(`${key} 缺少 electron-packager，请先在该目录执行 npm install`);
  for (const rel of job.resources) {
    if (!existsSync(join(root, rel))) fail(`${key} 缺少资源 ${rel}`);
  }

  const cliArgs = [
    packager, ".", job.name,
    "--platform=win32", "--arch=x64",
    `--icon=${iconPath}`,
    `--out=${outDir}`,
    "--overwrite", "--prune=true", "--asar",
    ...job.resources.map((rel) => `--extraResource=${join(root, rel)}`),
  ];

  console.log(`[pack] ${job.name} -> ${join(outDir, job.name + "-win32-x64")}`);
  const result = spawnSync(process.execPath, cliArgs, {
    cwd: job.appDir,
    stdio: "inherit",
    env: { ...process.env, TEMP: tmpDir, TMP: tmpDir },
  });
  if (result.status !== 0) failed = true;
}

if (failed) fail("打包失败，请查看上方日志");
console.log("[pack] 完成");
