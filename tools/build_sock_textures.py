"""Build the KHORA sock textures from the product photos.

    python3 tools/build_sock_textures.py <photo-dir>

<photo-dir> must contain socks_legs.png (the back-of-legs product shot: the right
sock shows the jacquard band straight on, the left sock shows the KHORA sole
lettering). Outputs to public/textures/:

  sock_albedo.jpg   atlas: left half = front layer, right half = back layer
                    (mirrored in x, like the tee), laid out on the flat
                    pattern in src/garments/socks-pattern.json
  sock_rib.png      tileable rib-knit normal map (4 ribs per tile)
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'textures')
P = json.load(open(os.path.join(ROOT, 'src', 'garments', 'socks-pattern.json')))
W, H = 2048, 1200
BLUE = np.array([228, 86, 8], np.float32)  # BGR, KHORA royal blue in yarn
BASE = np.array([24, 21, 20], np.float32)  # BGR, black cotton knit


def blue_mask(img):
    b, g, r = [img[..., i].astype(np.float32) for i in range(3)]
    m = np.clip((b - np.maximum(r, g) - 30) / 40, 0, 1)
    return cv2.GaussianBlur(m, (3, 3), 0)


def rotate(m, deg):
    h, w = m.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    return cv2.warpAffine(m, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)


def trim(m, thr=0.3, pad=2):
    ys, xs = np.where(m > thr)
    return m[max(0, ys.min() - pad): ys.max() + pad, max(0, xs.min() - pad): xs.max() + pad]


def main(photo_dir):
    legs = cv2.imread(os.path.join(photo_dir, 'socks_legs.png'))
    # --- jacquard band: right sock, seen straight on; the band dips ~10deg
    band = blue_mask(legs[700:990, 560:930])
    band = trim(rotate(band, -10.5))
    # --- sole lettering: left sock, reads bottom-to-top -> rotate upright
    text = blue_mask(legs[975:1290, 290:395])
    text = trim(cv2.rotate(text, cv2.ROTATE_90_CLOCKWISE))

    win = P['window']
    sx = (W / 2) / (win['x1'] - win['x0'])
    sy = H / (win['y1'] - win['y0'])

    def px(x, back):
        u = (win['x1'] - x) / (win['x1'] - win['x0']) if back else (x - win['x0']) / (win['x1'] - win['x0'])
        return u * W / 2 + (W / 2 if back else 0)

    def py(y):
        return (win['y1'] - y) * sy

    yy, xx = np.mgrid[0:H, 0:W // 2].astype(np.float32)
    rng = np.random.default_rng(7)
    img = np.zeros((H, W, 3), np.float32)
    for back in (False, True):
        x0 = W // 2 if back else 0
        # world coords of each texel of this half
        wx = (win['x1'] - xx / sx) if back else (win['x0'] + xx / sx)
        wy = win['y1'] - yy / sy
        # rib knit: fine vertical wales (2.4 mm), denser in the cuff
        rib_p = np.where(wy > P['cuffRib'][1], 0.0019, 0.0024)
        rib = 0.5 + 0.5 * np.cos(2 * np.pi * wx / rib_p)
        noise = rng.normal(0, 1, (H, W // 2)).astype(np.float32)
        noise = cv2.GaussianBlur(noise, (0, 0), 1.2) * 2.2
        shade = 0.82 + 0.3 * rib + 0.06 * noise
        col = BASE[None, None, :] * shade[..., None]
        # jacquard band, one repeat per side of the sock
        b0, b1 = P['band']
        xa, xb = px(-0.045, back), px(0.045, back)
        if xa > xb:
            xa, xb = xb, xa
        bw, bh = int(round(xb - xa)), int(round(py(b1) - py(b0)))
        m = cv2.resize(band, (bw, bh), interpolation=cv2.INTER_AREA)
        if back:
            m = m[:, ::-1]
        layer = np.zeros((H, W // 2), np.float32)
        ox, oy = int(round(xa - x0)), int(round(py(b0)))
        layer[oy: oy + bh, ox: ox + bw] = m
        # sole lettering
        s = P['sole']
        ta, tb = px(s['x0'], back), px(s['x1'], back)
        if ta > tb:
            ta, tb = tb, ta
        tw = int(round(tb - ta))
        th = int(round(s['h'] * sy))
        t = cv2.resize(text, (tw, th), interpolation=cv2.INTER_AREA)
        ty = int(round(py(s['y'] + s['h'] / 2)))
        tx = int(round(ta - x0))
        layer[ty: ty + th, tx: tx + tw] = np.maximum(layer[ty: ty + th, tx: tx + tw], t)
        knit = (0.85 + 0.25 * rib + 0.05 * noise)[..., None]
        col = col * (1 - layer[..., None]) + BLUE[None, None, :] * knit * layer[..., None]
        img[:, x0: x0 + W // 2] = col
    cv2.imwrite(os.path.join(OUT, 'sock_albedo.jpg'), np.clip(img, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])

    # --- rib normal tile: 4 wales across, soft rounded ridges + stitch rows
    T = 128
    x = np.arange(T, dtype=np.float32)
    hgt = (0.5 + 0.5 * np.cos(2 * np.pi * x * 4 / T)) ** 0.7
    y = np.arange(T, dtype=np.float32)
    rows = 0.08 * (0.5 + 0.5 * np.cos(2 * np.pi * y * 12 / T))
    hmap = hgt[None, :] + rows[:, None]
    dx = (np.roll(hmap, -1, 1) - np.roll(hmap, 1, 1)) * 2.2
    dy = (np.roll(hmap, -1, 0) - np.roll(hmap, 1, 0)) * 2.2
    n = np.dstack([-dx, dy, np.ones_like(dx)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    rgb = ((n * 0.5 + 0.5) * 255).astype(np.uint8)
    cv2.imwrite(os.path.join(OUT, 'sock_rib.png'), rgb[..., ::-1])
    print('wrote sock_albedo.jpg, sock_rib.png')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
