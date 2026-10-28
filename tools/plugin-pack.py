#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MagicHub 插件打包工具
=====================
把插件目录打成 .7z 安装包（上传到 MagicHub 插件市场用），并校验插件格式。

用法：
  python plugin-pack.py <插件目录> [-o 输出.7z] [--7z 7za.exe路径] [--init] [--list]

  <插件目录>  插件目录，其中必须包含 manifest.json
  -o/--out    输出 .7z 路径（默认 <插件目录> 同级: <id>-v<version>.7z）
  --7z        7za.exe 路径（默认本脚本同目录 7za.exe）
  --init      在插件目录生成 manifest.json 模板（配合 <目录> 使用）
  --list      只校验与展示插件信息，不打包

manifest.json 字段：
  id          必填，1-64 位字母/数字/_/-（市场唯一标识，也是目录名）
  name        必填，插件显示名
  version     必填，如 1.0.0
  entry       必填，入口 HTML，如 index.html
  icon        可选，图标 SVG/PNG 相对路径（如 icon.svg）
  description 可选，一句话描述

示例：
  python plugin-pack.py ./my-plugin
  python plugin-pack.py ./my-plugin --init
  python plugin-pack.py ./my-plugin -o dist/my-plugin.7z --7z C:/tools/7za.exe
"""
import argparse
import json
import os
import re
import subprocess
import sys

PLUGIN_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
REQUIRED = ("id", "name", "version", "entry")
TOOL_DIR = os.path.dirname(os.path.abspath(__file__))

MANIFEST_TEMPLATE = {
    "id": "my-plugin",
    "name": "我的插件",
    "version": "1.0.0",
    "entry": "index.html",
    "icon": "icon.svg",
    "description": "一句话介绍这个插件",
}


def find_7za(explicit):
    if explicit:
        return explicit
    cand = os.path.join(TOOL_DIR, "7za.exe")
    return cand if os.path.exists(cand) else None


def validate_manifest(dir_path):
    mf = os.path.join(dir_path, "manifest.json")
    if not os.path.exists(mf):
        return None, "缺少 manifest.json（可先运行 --init 生成模板）"
    try:
        with open(mf, "r", encoding="utf-8") as f:
            m = json.load(f)
    except Exception as e:
        return None, "manifest.json 不是合法 JSON: %s" % e
    if not isinstance(m, dict):
        return None, "manifest.json 必须是对象"
    for k in REQUIRED:
        if k not in m or not str(m[k]).strip():
            return None, "缺少必填字段: %s" % k
    if not PLUGIN_ID_RE.match(str(m["id"])):
        return None, "id 必须为 1-64 位字母/数字/_/-（当前: %s）" % m["id"]
    entry = str(m["entry"])
    if not os.path.exists(os.path.join(dir_path, entry)) or not os.path.isfile(os.path.join(dir_path, entry)):
        return None, "入口文件不存在: %s" % entry
    if m.get("icon"):
        icon = str(m["icon"])
        if not os.path.exists(os.path.join(dir_path, icon)):
            return None, "图标文件不存在: %s" % icon
    return m, None


def run_7za(seven_zip, args, cwd=None):
    try:
        r = subprocess.run([seven_zip] + args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    except FileNotFoundError:
        return False, "找不到 7za.exe（%s）" % seven_zip
    if r.returncode != 0:
        return False, (r.stderr or r.stdout or "7za 失败").strip()[:300]
    return True, ""


def do_pack(plugin_dir, out_path, seven_zip):
    m, err = validate_manifest(plugin_dir)
    if err:
        return False, err
    seven_zip = find_7za(seven_zip)
    if not seven_zip:
        return False, "未找到 7za.exe（用 --7z 指定，或把 7za.exe 放在本脚本同目录）"
    # 在插件目录内部打包，保证 .7z 根就是插件内容（manifest.json 在根）
    out_abs = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    ok, e = run_7za(seven_zip, ["a", "-t7z", "-mx=5", "-y", "-bso0", "-bsp0", out_abs, "*"], cwd=plugin_dir)
    if not ok:
        return False, e
    return True, "已生成 %s（%.1f KB）" % (out_abs, os.path.getsize(out_abs) / 1024)


def main():
    ap = argparse.ArgumentParser(description="MagicHub 插件打包/校验工具")
    ap.add_argument("dir", nargs="?", help="插件目录")
    ap.add_argument("-o", "--out", help="输出 .7z 路径")
    ap.add_argument("--7z", dest="seven_zip", help="7za.exe 路径")
    ap.add_argument("--init", action="store_true", help="在指定目录生成 manifest.json 模板")
    ap.add_argument("--list", action="store_true", help="只校验并打印插件信息，不打包")
    args = ap.parse_args()

    if args.init:
        if not args.dir:
            print("错误：--init 需要指定插件目录")
            sys.exit(1)
        os.makedirs(args.dir, exist_ok=True)
        mf = os.path.join(args.dir, "manifest.json")
        if os.path.exists(mf):
            print("已存在 %s，不覆盖" % mf)
        else:
            with open(mf, "w", encoding="utf-8") as f:
                json.dump(MANIFEST_TEMPLATE, f, ensure_ascii=False, indent=2)
            print("已生成模板: %s（按需修改 id/name/version/entry/icon/description）" % mf)
        sys.exit(0)

    if not args.dir:
        ap.print_help()
        sys.exit(1)

    if not os.path.isdir(args.dir):
        print("错误：插件目录不存在: %s" % args.dir)
        sys.exit(1)

    m, err = validate_manifest(args.dir)
    if err:
        print("✗ 格式校验失败：%s" % err)
        sys.exit(1)

    print("✔ 格式校验通过")
    print("  id          %s" % m["id"])
    print("  name        %s" % m["name"])
    print("  version     %s" % m["version"])
    print("  entry       %s" % m["entry"])
    if m.get("icon"):
        print("  icon        %s" % m["icon"])
    if m.get("description"):
        print("  description %s" % m["description"])

    if args.list:
        sys.exit(0)

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.dir)), "%s-v%s.7z" % (m["id"], m["version"]))
    ok, msg = do_pack(args.dir, out, args.seven_zip)
    if not ok:
        print("✗ 打包失败：%s" % msg)
        sys.exit(1)
    print("✔ %s" % msg)
    print("提示：在 MagicHub 客户端「插件市场」右上角上传按钮选择该 .7z 包即可发布。")


if __name__ == "__main__":
    main()
