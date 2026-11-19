"""
process_assets.py
Converts raw AI-generated images in raw_assets/ into clean, transparent-background
256x256 RGBA PNG sprites in public/assets/sprites/ and resizes the seamless ground tile.
"""

from collections import deque
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "raw_assets"
OUT_DIR = ROOT / "public" / "assets" / "sprites"


def detect_corner_bg_color(arr: np.ndarray) -> np.ndarray:
    """Sample corner patches of an RGB/RGBA image to estimate background color."""
    h, w = arr.shape[:2]
    pad = max(2, min(12, h // 20, w // 20))
    samples = np.concatenate([
        arr[:pad, :pad, :3].reshape(-1, 3),
        arr[:pad, -pad:, :3].reshape(-1, 3),
        arr[-pad:, :pad, :3].reshape(-1, 3),
        arr[-pad:, -pad:, :3].reshape(-1, 3),
    ], axis=0)
    return np.median(samples, axis=0).astype(np.float32)


def is_green_screen(bg_rgb: np.ndarray) -> bool:
    r, g, b = bg_rgb
    return g > 140 and g > r * 1.35 and g > b * 1.35


def remove_background(img: Image.Image) -> Image.Image:
    """
    Removes solid/green/light background connected to image borders with smooth
    alpha feathering and green-spill suppression, then auto-crops and pads to 256x256.
    """
    rgba = img.convert("RGBA")
    arr = np.array(rgba, dtype=np.float32)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3].copy()

    bg_rgb = detect_corner_bg_color(arr)
    green_mode = is_green_screen(bg_rgb)

    if green_mode:
        # Chroma-key distance + flood fill from edges to avoid eating interior green details
        # Compute how "green-screen" each pixel is
        r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        greenness = g - np.maximum(r, b)
        dist_bg = np.linalg.norm(rgb - bg_rgb[None, None, :], axis=2)
        bg_candidate = (dist_bg < 115.0) | ((greenness > 32.0) & (g > 90.0))
    else:
        dist_bg = np.linalg.norm(rgb - bg_rgb[None, None, :], axis=2)
        bg_candidate = dist_bg < 52.0

    # Flood-fill from all 4 borders through bg_candidate pixels
    visited = np.zeros((h, w), dtype=bool)
    queue = deque()

    for x in range(w):
        if bg_candidate[0, x]:
            visited[0, x] = True
            queue.append((0, x))
        if bg_candidate[h - 1, x] and not visited[h - 1, x]:
            visited[h - 1, x] = True
            queue.append((h - 1, x))
    for y in range(1, h - 1):
        if bg_candidate[y, 0] and not visited[y, 0]:
            visited[y, 0] = True
            queue.append((y, 0))
        if bg_candidate[y, w - 1] and not visited[y, w - 1]:
            visited[y, w - 1] = True
            queue.append((y, w - 1))

    while queue:
        cy, cx = queue.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and bg_candidate[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))

    # Also remove pure green-screen islands inside (e.g., between claws or cage bars)
    if green_mode:
        r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        strong_green = (g - np.maximum(r, b) > 55.0) & (g > 125.0) & (dist_bg < 110.0)
        visited |= strong_green

    alpha[visited] = 0.0

    # Feather 1-2px edge pixels adjacent to removed background & suppress green spill
    if green_mode:
        r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        # Dilate visited mask by 2 pixels to find boundary fringe
        padded = np.pad(visited, 1, mode="constant", constant_values=True)
        neighbor_bg = (
            padded[:-2, 1:-1] | padded[2:, 1:-1] |
            padded[1:-1, :-2] | padded[1:-1, 2:]
        )
        fringe = neighbor_bg & (~visited)
        green_excess = np.clip((g - np.maximum(r, b)) / 65.0, 0.0, 1.0)
        alpha[fringe] = np.minimum(alpha[fringe], 255.0 * (1.0 - 0.8 * green_excess[fringe]))

        # De-spill green tint on all semi-transparent / edge pixels
        spill_mask = (g > np.maximum(r, b)) & (fringe | (alpha < 250))
        rgb[spill_mask, 1] = np.maximum(r[spill_mask], b[spill_mask])

    out_arr = np.dstack([
        np.clip(rgb, 0, 255),
        np.clip(alpha, 0, 255)
    ]).astype(np.uint8)

    # Crop to non-transparent bounding box with small padding and center into 256x256
    cleaned = Image.fromarray(out_arr, mode="RGBA")
    bbox = cleaned.getbbox()
    if bbox:
        cropped = cleaned.crop(bbox)
        cw, ch = cropped.size
        target_inner = 224  # Leave clean 16px margin in 256x256 canvas
        scale = min(target_inner / max(1, cw), target_inner / max(1, ch))
        nw = max(1, int(round(cw * scale)))
        nh = max(1, int(round(ch * scale)))
        resized = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        ox = (256 - nw) // 2
        oy = (256 - nh) // 2
        canvas.paste(resized, (ox, oy), resized)
        return canvas

    return cleaned.resize((256, 256), Image.Resampling.LANCZOS)


def process_all() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sprite_map = {
        "werewolf_raw.png": "werewolf.png",
        "villager_raw.png": "villager.png",
        "totem_raw.png": "totem.png",
        "cage_raw.png": "cage.png",
    }

    for raw_name, out_name in sprite_map.items():
        raw_path = RAW_DIR / raw_name
        out_path = OUT_DIR / out_name
        if not raw_path.exists():
            raise FileNotFoundError(f"Missing raw asset: {raw_path}")
        with Image.open(raw_path) as img:
            processed = remove_background(img)
            processed.save(out_path, format="PNG")
            # Quick corner check
            px = processed.getpixel((0, 0))
            print(f"[OK] {raw_name} -> {out_path.name} ({processed.size}, corner RGBA={px})")

    ground_raw = RAW_DIR / "ground_tile.png"
    ground_out = OUT_DIR / "ground_tile.png"
    if not ground_raw.exists():
        raise FileNotFoundError(f"Missing raw ground tile: {ground_raw}")
    with Image.open(ground_raw) as gimg:
        tile = gimg.convert("RGB").resize((256, 256), Image.Resampling.LANCZOS)
        # Subtle seamless edge blend (12px mirrored/crossfade border) so tiling has zero harsh seams
        arr = np.array(tile, dtype=np.float32)
        b = 12
        for i in range(b):
            t = i / float(b)
            # Blend left-right seam
            left = arr[:, i, :].copy()
            right = arr[:, -1 - i, :].copy()
            avg_lr = 0.5 * (left + right)
            w = 0.5 * (1.0 - t)
            arr[:, i, :] = (1.0 - w) * left + w * avg_lr
            arr[:, -1 - i, :] = (1.0 - w) * right + w * avg_lr
        for i in range(b):
            t = i / float(b)
            top = arr[i, :, :].copy()
            bot = arr[-1 - i, :, :].copy()
            avg_tb = 0.5 * (top + bot)
            w = 0.5 * (1.0 - t)
            arr[i, :, :] = (1.0 - w) * top + w * avg_tb
            arr[-1 - i, :, :] = (1.0 - w) * bot + w * avg_tb
        seamless = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        seamless.save(ground_out, format="PNG")
        print(f"[OK] ground_tile.png -> {ground_out.name} ({seamless.size})")


if __name__ == "__main__":
    process_all()
