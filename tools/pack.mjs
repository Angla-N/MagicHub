/**
 * MagicHub 打包（客户端 exe / 服务端前端发布）
 *
 * 架构（实时更新 + 体积小）：
 *  - client：只打包 Electron 运行引擎 + 主进程 + 引导页（不含前端脚本），前端由运行时从服务器拉取缓存
 *  - server：不再打包 exe，改为"发布前端脚本包"（release/web/ + web-manifest.json），服务器以脚本方式运行
 *
 * 用法：
 *   node tools/pack.mjs             # 客户端打包 + 服务端发布
 *   node tools/pack.mjs client      # 只打包客户端
 *   node tools/pack.mjs server      # 只发布前端脚本包（版本自动递增）
 *   node tools/pack.mjs client --out=dist/xxx
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
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
    // 7za.exe 必须是 basename 直达（resources/7za.exe），与 main.js 的 process.resourcesPath/7za.exe 一致
    // boot.html 为内置引导页（首次拉取前端 / 服务器不可达时的错误与配置页）
    resources: ["brand", "apps/server-app/7za.exe", "apps/desktop/boot.html"],
  },
  server: { web: true },
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

/** 发布前端脚本包：复制 apps/web → release/web，版本递增，生成 web-manifest.json（sha256 清单） */
function publishWeb() {
  const srcRoot = join(root, "apps", "web");
  const dstRoot = join(root, "release", "web");
  const versionFile = join(srcRoot, "web-version.json");
  const EXCLUDE = new Set(["package.json", "scripts", "_shots", "web-version.json"]);

  let version = 0;
  if (existsSync(versionFile)) {
    try { version = Number(JSON.parse(readFileSync(versionFile, "utf8")).version) || 0; } catch { /* 0 */ }
  }
  version += 1;

  // 清空重建发布目录（保证与源一致，删除上次发布的残留文件）
  if (existsSync(dstRoot)) rmSync(dstRoot, { recursive: true, force: true });
  mkdirSync(dstRoot, { recursive: true });

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDE.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      const rel = relative(srcRoot, p).split("\\").join("/");
      if (st.isDirectory()) {
        if (name === "node_modules") continue;
        walk(p);
      } else {
        const buf = readFileSync(p);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        files.push({ path: rel, size: buf.length, sha256 });
        const dst = join(dstRoot, rel);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(p, dst);
      }
    }
  };
  walk(srcRoot);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    entry: "login.html",
    files,
  };
  writeFileSync(join(dstRoot, "web-manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8" });
  writeFileSync(versionFile, JSON.stringify({ version }, null, 2) + "\n", { encoding: "utf8" });

  const bytes = files.reduce((s, f) => s + f.size, 0);
  console.log(`[pack] 前端发布 v${version} -> release/web/（${files.length} 个文件，${(bytes / 1024).toFixed(1)} KB）`);
  return version;
}

let failed = false;
for (const key of wanted) {
  const job = jobs[key];

  if (job.web) {
    publishWeb();
    continue;
  }

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
