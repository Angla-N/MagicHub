# -*- coding: utf-8 -*-
"""MagicHub 程序图标生成器
依据用户提供的聊天气泡字形（D:\\聊天.svg），生成：
  - brand/icon.svg          矢量主稿（手写，与本站一致）
  - brand/icon-1024.png     高清主位图
  - brand/icon-256.png      常规 256px
  - brand/icon.ico          多尺寸 Windows 图标（16/24/32/48/64/128/256）
"""
import io, struct
from PIL import Image, ImageDraw

SIZE = 1024
C0 = (124, 58, 237)   # #7C3AED
C1 = (168, 85, 247)   # #A855F7
WHITE = (255, 255, 255, 255)

SCALE = 0.68
OX, OY = 146, 168     # 气泡字形在 1024 画布中的位移

def tr(x, y):
    return (x * SCALE + OX, y * SCALE + OY)

# 气泡外轮廓（原 1077.894737 x 1024 viewBox 的等比缩放）
OUTER = [(0, 0), (1077.894737, 0), (1077.894737, 808.421053),
         (831.703579, 808.421053), (796.672, 1023.578947),
         (417.5764, 808.421053), (0, 808.421053)]
OUTER = [tr(x, y) for x, y in OUTER]

DOTS = [(269.473684, 323.368421, 107.789474, 161.684211),
        (646.736842, 323.368421, 107.789474, 161.684211)]

def make_gradient_bg(size):
    """135° 对角线性渐变背景"""
    small = Image.new("RGB", (64, 64))
    d = ImageDraw.Draw(small)
    for y in range(64):
        for x in range(64):
            t = (x + y) / (2 * 63)
            r = int(C0[0] + (C1[0] - C0[0]) * t)
            g = int(C0[1] + (C1[1] - C0[1]) * t)
            b = int(C0[2] + (C1[2] - C0[2]) * t)
            d.point((x, y), fill=(r, g, b))
    return small.resize((size, size), Image.BILINEAR)

def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = make_gradient_bg(size)
    img.paste(grad, (0, 0), Image.new("L", (size, size), 255))

    d = ImageDraw.Draw(img)
    k = size / SIZE
    r = 212 * k
    margin = 64 * k

    # 圆角底（直接用圆角遮罩裁剪，见下方 putalpha）
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([margin, margin, size - margin, size - margin],
                         radius=r, fill=255)
    img.putalpha(mask)

    # 内描边（高光）
    bw = max(2, int(8 * k))
    d.rounded_rectangle([margin + bw / 2, margin + bw / 2,
                         size - margin - bw / 2, size - margin - bw / 2],
                        radius=r - bw / 2, outline=(255, 255, 255, 42), width=bw)

    # 白色气泡
    d.polygon([(px * k, py * k) for px, py in OUTER], fill=WHITE)
    for x, y, w, h in DOTS:
        d.rectangle([x * k * SCALE + OX * k, y * k * SCALE + OY * k,
                     (x + w) * k * SCALE + OX * k, (y + h) * k * SCALE + OY * k],
                    fill=WHITE)
    return img

def write_ico(path, master, sizes):
    entries = []
    offset = 6 + 16 * len(sizes)
    blobs = []
    for s in sizes:
        img = master.resize((s, s), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        data = buf.getvalue()
        w = 0 if s >= 256 else s
        entries.append(struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
        blobs.append(data)
    with open(path, "wb") as f:
        f.write(struct.pack("<HHH", 0, 1, len(sizes)))
        for e in entries:
            f.write(e)
        for b in blobs:
            f.write(b)

if __name__ == "__main__":
    master = draw_icon(SIZE)
    master.save(r"D:\C++Project\MagicHub\brand\icon-1024.png")
    master.resize((256, 256), Image.LANCZOS).save(r"D:\C++Project\MagicHub\brand\icon-256.png")
    write_ico(r"D:\C++Project\MagicHub\brand\icon.ico", master,
              [16, 24, 32, 48, 64, 128, 256])
    print("icon generated OK")
