from __future__ import annotations

import binascii
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


def hex_color(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha


def write_png(path: Path, width: int, height: int, pixels: bytearray) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + pixels[y * width * 4 : (y + 1) * width * 4] for y in range(height))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def blend_pixel(pixels: bytearray, size: int, px: int, py: int, color: tuple[int, int, int, int]) -> None:
    if px < 0 or py < 0 or px >= size or py >= size:
        return
    idx = (py * size + px) * 4
    sr, sg, sb, sa = color
    alpha = sa / 255
    inv = 1 - alpha
    pixels[idx] = round(sr * alpha + pixels[idx] * inv)
    pixels[idx + 1] = round(sg * alpha + pixels[idx + 1] * inv)
    pixels[idx + 2] = round(sb * alpha + pixels[idx + 2] * inv)
    pixels[idx + 3] = min(255, round(sa + pixels[idx + 3] * inv))


def rounded_rect_alpha(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> float:
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    dist = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, radius + 0.55 - dist))


def dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx = bx - ax
    dy = by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def draw_icon(size: int, maskable: bool = False) -> bytearray:
    pixels = bytearray(size * size * 4)
    scale = size / 64

    for py in range(size):
        for px in range(size):
            x = (px + 0.5) / scale
            y = (py + 0.5) / scale

            if maskable:
                blend_pixel(pixels, size, px, py, hex_color("#070b0f"))

            outer = rounded_rect_alpha(x, y, 3, 3, 61, 61, 14)
            if outer:
                blend_pixel(pixels, size, px, py, hex_color("#070b0f", round(outer * 255)))

            inner = rounded_rect_alpha(x, y, 5, 5, 59, 59, 12)
            if inner:
                blend_pixel(pixels, size, px, py, hex_color("#0b1116", round(inner * 255)))

            edge = outer - rounded_rect_alpha(x, y, 6.7, 6.7, 57.3, 57.3, 10.5)
            if edge > 0:
                t = (x + y) / 128
                color = (
                    round(34 * (1 - t) + 255 * t),
                    round(245 * (1 - t) + 178 * t),
                    round(255 * (1 - t) + 30 * t),
                    round(min(edge, 1) * 210),
                )
                blend_pixel(pixels, size, px, py, color)

            for ax, ay, bx, by in [(9, 32, 28, 26), (9, 39, 30, 35), (42, 28, 55, 24), (43, 36, 55, 40)]:
                if dist_to_segment(x, y, ax, ay, bx, by) <= 0.7:
                    blend_pixel(pixels, size, px, py, hex_color("#18dff0", 95))

            a_path = [(15, 42, 31.8, 17.5), (32.2, 17.5, 49, 42)]
            if any(dist_to_segment(x, y, *segment) <= 5 for segment in a_path):
                blend_pixel(pixels, size, px, py, hex_color("#111820"))
            if any(dist_to_segment(x, y, *segment) <= 3.6 for segment in a_path):
                t = y / 64
                color = (
                    round(248 * (1 - t) + 255 * t),
                    round(251 * (1 - t) + 191 * t),
                    round(255 * (1 - t) + 53 * t),
                    255,
                )
                blend_pixel(pixels, size, px, py, color)
            if any(dist_to_segment(x, y, *segment) <= 0.75 for segment in [(19, 39, 31.8, 17.8), (32.2, 17.8, 45, 39)]):
                blend_pixel(pixels, size, px, py, hex_color("#ffffff", 90))

            if abs(math.hypot(x - 32, y - 32) - 19) <= 1.6 and x <= 50 and y <= 39:
                blend_pixel(pixels, size, px, py, hex_color("#25f4ff", 210))
            if abs(math.hypot(x - 42, y - 34) - 10) <= 1.45 and x >= 48:
                blend_pixel(pixels, size, px, py, hex_color("#ffb21e", 210))

            if math.hypot(x - 15, y - 35) <= 3.4:
                blend_pixel(pixels, size, px, py, hex_color("#5effff"))
            if math.hypot(x - 50, y - 25) <= 3.5:
                blend_pixel(pixels, size, px, py, hex_color("#ffc454"))

            body = rounded_rect_alpha(x, y, 22, 35, 42, 47, 5.5)
            if body:
                blend_pixel(pixels, size, px, py, hex_color("#05090d", round(body * 255)))
            body_edge = body - rounded_rect_alpha(x, y, 23.8, 36.8, 40.2, 45.2, 3.8)
            if body_edge > 0:
                blend_pixel(pixels, size, px, py, hex_color("#eafcff", round(min(body_edge, 1) * 170)))
            if dist_to_segment(x, y, 32, 35, 32, 30) <= 0.7:
                blend_pixel(pixels, size, px, py, hex_color("#eafcff", 210))
            if math.hypot(x - 32, y - 29) <= 2.3:
                blend_pixel(pixels, size, px, py, hex_color("#30f3ff"))
            for left in (27, 34):
                eye = rounded_rect_alpha(x, y, left, 39, left + 3, 44, 1.5)
                if eye:
                    blend_pixel(pixels, size, px, py, hex_color("#36f8ff", round(eye * 255)))

    return pixels


def main() -> None:
    icons = {
        "icons/icon-32.png": (32, False),
        "icons/icon-192.png": (192, False),
        "icons/icon-512.png": (512, False),
        "icons/maskable-icon-192.png": (192, True),
        "icons/maskable-icon-512.png": (512, True),
        "apple-touch-icon.png": (180, False),
    }
    for relative_path, (size, maskable) in icons.items():
        write_png(PUBLIC / relative_path, size, size, draw_icon(size, maskable))
    print(f"Generated {len(icons)} Auto-AI app icons.")


if __name__ == "__main__":
    main()
