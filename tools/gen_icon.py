# 生成应用图标：粉色圆角方块 + 白色爱心
# 运行方式： python tools/gen_icon.py
import os
import math
from PIL import Image, ImageDraw

SS = 4                 # 超采样倍数，让边缘更顺滑
SIZE = 256
W = SIZE * SS

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, c1, c2):
    """从左上到右下的线性渐变"""
    img = Image.new('RGB', (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return img


def heart_mask(size, pad_ratio=0.11):
    """用和程序里完全一样的心形参数方程生成 alpha 蒙版
       x = 16sin³t, y = 13cos t - 5cos2t - 2cos3t - cos4t"""
    pts = []
    n = 720
    for i in range(n):
        t = i / n * 2 * math.pi
        s = math.sin(t)
        pts.append((
            16 * s ** 3,
            13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t),
        ))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
    w, h = xmax - xmin, ymax - ymin
    span = (1 - pad_ratio * 2) * size
    scale = min(span / w, span / h)
    ox = size / 2 - (xmin + w / 2) * scale
    oy = size / 2 + (ymin + h / 2) * scale
    poly = [(x * scale + ox, -y * scale + oy) for x, y in pts]

    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).polygon(poly, fill=255)
    return m


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    bg = gradient(W, (255, 176, 205), (233, 62, 124)).convert('RGBA')
    bg.putalpha(rounded_mask(W, radius=int(W * 0.22)))

    white = Image.new('RGBA', (W, W), (255, 255, 255, 255))
    white.putalpha(heart_mask(W))

    icon = Image.alpha_composite(bg, white)
    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)

    png_path = os.path.join(OUT_DIR, 'icon.png')
    ico_path = os.path.join(OUT_DIR, 'icon.ico')
    icon.save(png_path)
    icon.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('已生成:', png_path)
    print('已生成:', ico_path)


if __name__ == '__main__':
    main()
