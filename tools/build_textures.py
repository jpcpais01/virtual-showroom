"""
Builds every garment / brand texture used by the showroom from the original
product photos.

    python3 tools/build_textures.py <photo-dir>

<photo-dir> must contain the four KHORA product shots (front close-up 1712,
front on-body 797, back on-body 804_P, chest close-up 866). The outputs are
written to public/textures and src/garments/tee-pattern.json and are committed,
so this only needs re-running when the source photos or the pattern change.

Outputs
  tee_albedo.jpg   colour atlas, left half = front panel, right half = back
  tee_aux.png      R = height (embroidery / print / seams), G = roughness
  knit_normal.png  tileable cotton-jersey normal map (micro detail)
  neck_label.jpg   the woven blue KHORA label, rectified from the photo
  print_mask.png   back print alone (R = blue ink, G = black ink) for the neon wall piece
  wordmark.png     white KHORA wordmark lifted from the woven label (alpha)
  monogram.png     K-heart monogram (alpha)
"""
import glob
import json
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures")
os.makedirs(OUT, exist_ok=True)

BRAND_BLUE = np.array([0, 78, 205], np.float32)  # measured from print + label
EMBROIDERY = np.array([30, 32, 42], np.float32)  # navy-black thread
PRINT_BLACK = np.array([44, 44, 47], np.float32)  # back monogram / wordmark ink
COTTON = np.array([244, 243, 239], np.float32)  # optical white heavyweight cotton


def photo(tag):
    hits = glob.glob(os.path.join(sys.argv[1], f"*{tag}*"))
    if not hits:
        sys.exit(f"missing photo *{tag}*")
    return np.asarray(Image.open(hits[0]).convert("RGB")).astype(np.float32)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# --------------------------------------------------------------------------
# 1. Garment pattern (metres). Origin = high point of shoulder (side neck
#    point), +x to the wearer's left when seen from the front, +y up.
# --------------------------------------------------------------------------
N = (0.105, 0.0)  # side neck point
S = (0.33, -0.065)  # dropped shoulder point (sleeve attach seam top)
ang = math.radians(-28)
T = (S[0] + 0.22 * math.cos(ang), S[1] + 0.22 * math.sin(ang))  # sleeve top at cuff
U = (T[0] + 0.215 * math.sin(ang), T[1] - 0.215 * math.cos(ang))  # sleeve bottom at cuff
A = (0.312, -0.315)  # underarm
H = (0.312, -0.74)  # side hem
FRONT_NECK = 0.098
BACK_NECK = 0.025


def ellipse(rx, ry, n=24):
    # from side neck point (rx,0) to centre (0,-ry)
    return [(rx * math.cos(t), -ry * math.sin(t)) for t in np.linspace(0, math.pi / 2, n)]


def bezier(p0, c, p1, n=16):
    return [
        ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
         (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1])
        for t in np.linspace(0, 1, n)
    ]


underarm = bezier(U, (0.335, -0.335), A)
pattern = {
    "units": "m",
    "note": "right half (x>=0); mirrored for x<0. Seams shared between front and back.",
    "N": N, "S": S, "T": T, "U": U, "A": A, "H": H,
    "frontNeck": FRONT_NECK, "backNeck": BACK_NECK,
    "underarmCtrl": (0.335, -0.335),
    "hemY": H[1],
    # uv window: panel coordinates covered by each half of the atlas
    "window": {"x0": -0.56, "x1": 0.56, "y0": -0.78, "y1": 0.04},
}
W = pattern["window"]
HALF_W = 2048
PX_PER_M = HALF_W / (W["x1"] - W["x0"])
H_PX = int(round((W["y1"] - W["y0"]) * PX_PER_M))
ATLAS = (H_PX, HALF_W * 2)
pattern["atlas"] = {"width": HALF_W * 2, "height": H_PX}
with open(os.path.join(ROOT, "src", "garments", "tee-pattern.json"), "w") as f:
    json.dump(pattern, f, indent=2)


def to_px(x, y, back):
    u = (W["x1"] - x) if back else (x - W["x0"])
    return (u * PX_PER_M + (HALF_W if back else 0), (W["y1"] - y) * PX_PER_M)


def outline(neck_depth):
    right = ellipse(N[0], neck_depth)[::-1]  # centre neck -> N
    right += [S, T, U] + underarm[1:] + [H, (0.0, H[1])]
    left = [(-x, y) for (x, y) in right[::-1]]
    return right + left[1:-1]


def poly_px(points, back):
    return np.array([to_px(x, y, back) for x, y in points], np.float32)


# --------------------------------------------------------------------------
# 2. Extract artwork from the photos
# --------------------------------------------------------------------------
def extract_back_print():
    img = photo("804_P")[1400:3900, 1150:3000]
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    blueness = B - (R + G) / 2
    blue_a = smoothstep(30, 135, blueness)
    L = 0.3 * R + 0.59 * G + 0.11 * B
    # local "white" level of the shirt so fold shading is not read as ink
    paper = cv2.dilate(L, np.ones((41, 41), np.uint8))
    paper = cv2.GaussianBlur(paper, (0, 0), 25)
    dark_a = smoothstep(0.22, 0.62, (paper - L) / np.maximum(paper, 1))
    dark_a *= 1 - smoothstep(10, 45, blueness)
    for a in (blue_a, dark_a):
        m = (a > 0.5).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] < 60:
                a[lab == i] = 0
    # drop anything outside the artwork (photo border / arm shadow)
    ys, xs = np.nonzero(blue_a > 0.5)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    keep = np.zeros_like(blue_a)
    keep[y0 - 20: img.shape[0], max(0, x0 - 20): x1 + 20] = 1
    blue_a *= keep
    # black ink (K monogram + KHORA wordmark) only lives in the middle band
    bw = x1 - x0
    keep[:, : x0 + int(0.25 * bw)] = 0
    keep[:, x1 - int(0.06 * bw):] = 0
    dark_a *= keep
    # the photo is shot on a body: level the artwork using the KHORA baseline
    low = (dark_a > 0.5) & (np.arange(dark_a.shape[0])[:, None] > y1 - 10)
    pts = np.column_stack(np.nonzero(low)[::-1]).astype(np.float32)
    (wx, wy), (ww, wh), rot = cv2.minAreaRect(pts)
    if ww < wh:
        rot -= 90
    if rot < -45:
        rot += 90
    if rot > 45:
        rot -= 90
    print("levelling print by", rot)
    M = cv2.getRotationMatrix2D(((x0 + x1) / 2, (y0 + y1) / 2), rot, 1.0)
    blue_a = cv2.warpAffine(blue_a, M, blue_a.shape[::-1], flags=cv2.INTER_CUBIC)
    dark_a = cv2.warpAffine(dark_a, M, dark_a.shape[::-1], flags=cv2.INTER_CUBIC)
    ys, xs = np.nonzero(blue_a > 0.5)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    dys, dxs = np.nonzero(dark_a > 0.5)
    y1 = max(y1, dys.max())
    pad = 24
    sl = (slice(max(0, y0 - pad), y1 + pad), slice(max(0, x0 - pad), x1 + pad))
    return blue_a[sl], dark_a[sl], (x1 - x0)


def extract_monogram():
    img = photo("866")[2900:4000, 2000:2900]
    L = img.mean(axis=2)
    paper = cv2.GaussianBlur(cv2.dilate(L, np.ones((31, 31), np.uint8)), (0, 0), 20)
    a = smoothstep(0.18, 0.5, (paper - L) / paper)
    m = (a > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    big = 1 + np.argsort(stats[1:, cv2.CC_STAT_AREA])[::-1]
    keepmask = np.isin(lab, big[:3])  # the K-heart is 1-3 thread blobs
    keepmask = cv2.dilate(keepmask.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    a *= keepmask
    # de-skew: the close-up was shot at a slight angle
    pts = np.column_stack(np.nonzero(a > 0.5)[::-1]).astype(np.float32)
    (cx, cy), (w, h), rot = cv2.minAreaRect(pts)
    if w > h:
        rot -= 90
        w, h = h, w
    M = cv2.getRotationMatrix2D((cx, cy), rot, 1.0)
    a = cv2.warpAffine(a, M, (a.shape[1], a.shape[0]), flags=cv2.INTER_CUBIC)
    # thread has sparkly gaps; close them so the stitched area reads as solid
    a = smoothstep(0.25, 0.55, cv2.GaussianBlur(a, (0, 0), 5))
    ys, xs = np.nonzero(a > 0.4)
    pad = 12
    return a[ys.min() - pad: ys.max() + pad, xs.min() - pad: xs.max() + pad]


def extract_label():
    img = photo("1712")[450:1050, 1600:2400]
    src = np.float32([[133, 240], [638, 127], [686, 354], [184, 440]])
    dst = np.float32([[0, 0], [700, 0], [700, 330], [0, 330]])
    M = cv2.getPerspectiveTransform(src, dst)
    lab = cv2.warpPerspective(img, M, (700, 330), flags=cv2.INTER_CUBIC)
    lab = lab[14:316, 16:684]
    R, G, B = lab[..., 0], lab[..., 1], lab[..., 2]
    white = smoothstep(60, 150, (R + G) / 2 - 0.25 * B)  # woven white yarn
    # rebuild a clean label: real woven texture from photo, text kept
    out = cv2.resize(lab, (512, 232), interpolation=cv2.INTER_AREA)
    wm = cv2.resize(white, (512, 232), interpolation=cv2.INTER_AREA)
    m = (white > 0.5).astype(np.uint8)
    n, lab_cc, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    big = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 150]
    white = white * cv2.dilate(np.isin(lab_cc, big).astype(np.uint8), np.ones((5, 5), np.uint8))
    ys, xs = np.nonzero(white > 0.5)
    word = white[max(0, ys.min() - 6): ys.max() + 6, max(0, xs.min() - 6): xs.max() + 6]
    return out, word


blue_a, dark_a, blue_w_px = extract_back_print()
mono_a = extract_monogram()
label_rgb, wordmark_a = extract_label()
print("print", blue_a.shape, "mono", mono_a.shape, "word", wordmark_a.shape)

Image.fromarray(np.clip(label_rgb, 0, 255).astype(np.uint8)).save(
    os.path.join(OUT, "neck_label.jpg"), quality=92)
wm = np.zeros(wordmark_a.shape + (4,), np.uint8)
wm[..., :3] = 255
wm[..., 3] = (wordmark_a * 255).astype(np.uint8)
Image.fromarray(wm).save(os.path.join(OUT, "wordmark.png"))
mm = np.zeros(mono_a.shape + (4,), np.uint8)
mm[..., :3] = 255
mm[..., 3] = (mono_a * 255).astype(np.uint8)
Image.fromarray(mm).save(os.path.join(OUT, "monogram.png"))
pm = np.zeros(blue_a.shape + (3,), np.uint8)
pm[..., 0] = (blue_a * 255).astype(np.uint8)
pm[..., 1] = (dark_a * 255).astype(np.uint8)
pmi = Image.fromarray(pm)
pmi.thumbnail((1400, 1400), Image.LANCZOS)
pmi.save(os.path.join(OUT, "print_mask.png"))

# --------------------------------------------------------------------------
# 3. Compose the garment atlas
# --------------------------------------------------------------------------
rng = np.random.default_rng(7)
Hh, Ww = ATLAS
color = np.empty((Hh, Ww, 3), np.float32)
color[:] = COTTON
# very low-frequency yarn/dye variation so the white never looks like plastic
noise = cv2.GaussianBlur(rng.normal(0, 1, (Hh // 8, Ww // 8)).astype(np.float32), (0, 0), 2)
noise = cv2.resize(noise, (Ww, Hh), interpolation=cv2.INTER_CUBIC)
color += noise[..., None] * 1.6
height = np.full((Hh, Ww), 0.5, np.float32)
rough = np.full((Hh, Ww), 0.86, np.float32)


def place(alpha, cx, cy, width_m, back):
    """Resample alpha so its width is width_m, centred at panel coords (cx,cy)."""
    w = max(2, int(round(width_m * PX_PER_M)))
    h = max(2, int(round(alpha.shape[0] * w / alpha.shape[1])))
    a = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_AREA)
    if back:
        pass  # artwork is already as seen from behind; to_px mirrors x for us
    px, py = to_px(cx, cy, back)
    x0, y0 = int(round(px - w / 2)), int(round(py - h / 2))
    full = np.zeros((Hh, Ww), np.float32)
    full[y0:y0 + h, x0:x0 + w] = a
    return full


# back print: blue tribal heart is 0.36 m wide, its top 8.5 cm under back neck
scale_w = 0.36 * blue_a.shape[1] / blue_w_px
h_m = scale_w * blue_a.shape[0] / blue_a.shape[1]
top_y = -BACK_NECK - 0.085
print_cy = top_y - h_m / 2 + 24 / PX_PER_M
blue_full = place(blue_a, 0.0, print_cy, scale_w, True)
dark_full = place(dark_a, 0.0, print_cy, scale_w, True)
ink = np.clip(blue_full + dark_full, 0, 1)
color = color * (1 - blue_full[..., None]) + BRAND_BLUE * blue_full[..., None]
color = color * (1 - dark_full[..., None]) + PRINT_BLACK * dark_full[..., None]
# plastisol print: slightly raised, smoother, with micro cracking breakup
ink_soft = cv2.GaussianBlur(ink, (0, 0), 1.2)
height += ink_soft * 0.16
rough = rough * (1 - ink) + 0.62 * ink

# front embroidery: 2.3 cm wide K-heart, centre 11 cm under the front neck
mono_full = place(mono_a, 0.0, -FRONT_NECK - 0.112, 0.023, False)
yy, xx = np.mgrid[0:Hh, 0:Ww].astype(np.float32)
satin = 0.5 + 0.5 * np.sin((xx * 0.8 + yy * 0.55) * 2.2)  # satin-stitch striation
thread = mono_full * (0.75 + 0.25 * satin)
color = color * (1 - mono_full[..., None]) + (EMBROIDERY * (0.85 + 0.3 * satin[..., None])) * mono_full[..., None]
height += cv2.GaussianBlur(thread, (0, 0), 0.8) * 0.4
rough = rough * (1 - mono_full) + 0.55 * mono_full


def stroke(mask_img, pts, back, width_px, value):
    p = poly_px(pts, back).astype(np.int32)
    cv2.polylines(mask_img, [p], False, value, int(width_px), cv2.LINE_AA)


def stitch_line(pts, back, offset_m, depth=0.09):
    """Double-needle cover stitch: dashed groove offset from an edge."""
    m = np.zeros((Hh, Ww), np.float32)
    p = poly_px(pts, back)
    # offset inward by sampling normals
    out = []
    for i in range(len(p)):
        a = p[max(0, i - 1)]
        b = p[min(len(p) - 1, i + 1)]
        t = b - a
        t /= np.linalg.norm(t) + 1e-9
        n = np.array([-t[1], t[0]])
        out.append(p[i] + n * offset_m * PX_PER_M)
    out = np.array(out)
    # resample & dash (2.5 mm stitch length)
    seg = np.linalg.norm(np.diff(out, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    step = 0.0025 * PX_PER_M
    for k in np.arange(0, s[-1] - step, step):
        if int(k / step) % 2:
            continue
        a = np.array([np.interp(k, s, out[:, 0]), np.interp(k, s, out[:, 1])])
        b = np.array([np.interp(k + step * 0.8, s, out[:, 0]), np.interp(k + step * 0.8, s, out[:, 1])])
        cv2.line(m, tuple(np.round(a * 4).astype(int)), tuple(np.round(b * 4).astype(int)), 1.0, 2, cv2.LINE_AA, shift=2)
    return m


def full(points):
    """Mirror a right-half polyline to a symmetric full polyline."""
    left = [(-x, y) for (x, y) in points[::-1]]
    return left + points[1:]


seams = np.zeros((Hh, Ww), np.float32)
for back in (False, True):
    neck = ellipse(N[0], BACK_NECK if back else FRONT_NECK)[::-1]
    neck_full = full(neck)
    hem = [(0.0, H[1]), H]
    hem_full = full(hem)
    cuff_r = [T, U]
    # rib collar band 2.4 cm: fine vertical ribs + slightly cooler tone
    band = np.zeros((Hh, Ww), np.float32)
    stroke(band, neck_full, back, 0.048 * PX_PER_M, 1.0)  # both sides of edge, outside half is clipped by geometry
    band = cv2.GaussianBlur(band, (0, 0), 1.0)
    # ribs: stripes perpendicular to the neck edge, approximated radially from the neck centre
    cx, cy = to_px(0, -(BACK_NECK if back else FRONT_NECK) * 0.5, back)
    ang_map = np.arctan2(yy - cy, xx - cx)
    ribs = 0.5 + 0.5 * np.sin(ang_map * 260)
    height += band * (ribs - 0.5) * 0.12
    color -= band[..., None] * 3.0
    # stitching: collar seam, hem, sleeve cuffs (two needles 6 mm apart)
    seams += stitch_line(neck_full, back, 0.025)
    seams += stitch_line(hem_full, back, -0.022)
    seams += stitch_line(hem_full, back, -0.028)
    for sgn in (1, -1):
        cuff = [(sgn * x, y) for x, y in cuff_r]
        off = 1 if sgn > 0 else -1
        seams += stitch_line(cuff, back, 0.022 * off)
        seams += stitch_line(cuff, back, 0.028 * off)
    # dropped-shoulder sleeve attach seam (S -> A), a soft ridge
    for sgn in (1, -1):
        g = np.zeros((Hh, Ww), np.float32)
        stroke(g, [(sgn * S[0], S[1]), (sgn * (A[0] + 0.004), A[1])], back, 3, 1.0)
        g = cv2.GaussianBlur(g, (0, 0), 2.5)
        height += g * 0.08
        color -= g[..., None] * 4

seams = np.clip(seams, 0, 1)
height -= seams * 0.09
color -= seams[..., None] * 16

color = np.clip(color, 0, 255).astype(np.uint8)
Image.fromarray(color).save(os.path.join(OUT, "tee_albedo.jpg"), quality=93)
aux = np.zeros((Hh, Ww, 3), np.uint8)
aux[..., 0] = np.clip(height * 255, 0, 255).astype(np.uint8)
aux[..., 1] = np.clip(rough * 255, 0, 255).astype(np.uint8)
Image.fromarray(aux).resize((Ww // 2, Hh // 2), Image.LANCZOS).save(os.path.join(OUT, "tee_aux.png"))

# --------------------------------------------------------------------------
# 4. Tileable single-jersey knit normal map. One tile = 8 wales x 12 courses.
# --------------------------------------------------------------------------
S_T = 256
y, x = np.mgrid[0:S_T, 0:S_T].astype(np.float32)
wales, courses = 8, 12
u = (x / S_T * wales) % 1.0
v = (y / S_T * courses) % 1.0
# each stitch is a "V": two slanted loops
d1 = np.abs((u - 0.25) - (v - 0.5) * 0.45)
d2 = np.abs((u - 0.75) + (v - 0.5) * 0.45)
loop = np.exp(-(np.minimum(d1, d2) / 0.16) ** 2)
loop *= 0.75 + 0.25 * np.cos((v - 0.5) * math.pi)
h = cv2.GaussianBlur(loop, (0, 0), 1.0)
h += cv2.GaussianBlur(rng.normal(0, 0.08, (S_T, S_T)).astype(np.float32), (0, 0), 1.5)
gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 4
gy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 4
nz = np.ones_like(h) * 1.0
strength = 1.6
n = np.dstack([-gx * strength, gy * strength, nz])
n /= np.linalg.norm(n, axis=2, keepdims=True)
Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(OUT, "knit_normal.png"))
print("done", ATLAS)
