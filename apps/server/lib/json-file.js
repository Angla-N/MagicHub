/**
 * MagicHub · json-file —— JSON 文件安全读写公共层
 *
 *  - 原子写：临时文件 + rename 覆盖，进程中途崩溃/断电不会留下半截主文件
 *  - 损坏恢复：主文件解析失败时优先尝试 <file>.bak，恢复成功后回写主文件
 *  - 拒绝覆盖：主文件与备份都损坏时抛错（调用方返回 500），绝不静默返回空后覆盖丢数据
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

/** 原子写文件（UTF-8） */
export function atomicWrite(file, data) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  writeFileSync(tmp, data, "utf8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    throw err;
  }
}

/** 写前把当前文件备份为 <file>.bak（保留上一个完好版本） */
export function backupBeforeWrite(file) {
  try {
    if (existsSync(file)) copyFileSync(file, file + ".bak");
  } catch (err) {
    console.error(`[json] 备份 ${file} 失败（不影响写入）: ${err.message}`);
  }
}

/**
 * 安全读取 JSON 文件；损坏时尝试 .bak 恢复，全部失败则抛错。
 * @param {string} file
 * @param {string} label 日志标识
 * @returns {any}
 */
export function loadJsonOrThrow(file, label) {
  const read = (f) => {
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8"));
  };
  try {
    const v = read(file);
    if (v !== null) return v;
  } catch (err) {
    // 主文件损坏：尝试备份
    const bak = file + ".bak";
    try {
      const fromBak = read(bak);
      if (fromBak !== null) {
        console.error(`[json] ${label} 主文件损坏，已从备份恢复: ${err.message}`);
        atomicWrite(file, JSON.stringify(fromBak, null, 2) + "\n");
        return fromBak;
      }
    } catch (e2) { /* 备份也损坏 */ }
    console.error(`[json] ${label} 主文件与备份均不可读，拒绝继续写入以免覆盖数据: ${err.message}`);
    throw new Error(`${label} 存储文件损坏，请检查 data/ 下文件`);
  }
  return null;
}

/** 便捷：写入 JSON 文件（备份 + 原子写） */
export function saveJson(file, value, label) {
  backupBeforeWrite(file);
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}
