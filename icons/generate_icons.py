#!/usr/bin/env python3
"""Generates icon16/48/128.png: a green rounded-square app icon with a white
form card, two lines of "filled text", and a pen crossing the bottom-right
corner. Run manually when the design needs to change; not part of the
extension's runtime.
"""

from PIL import Image, ImageDraw
import numpy as np

GREEN = (21, 128, 61, 255)      # #15803d
WHITE = (255, 255, 255, 255)
LINE2_ALPHA = 102                # ~40% of 255

SUPERSAMPLE = 8


def resize_rgba(img, size):
    # Plain RGBA resize lets fully-transparent pixels' stale RGB values leak
    # into the downscaled edge colors (a light halo around every hard edge,
    # most visible on the small 16px icon) — premultiplying by alpha first
    # and un-premultiplying after avoids that.
    arr = np.asarray(img, dtype=np.float32)
    rgb, a = arr[..., :3], arr[..., 3:4]
    premultiplied = np.concatenate([rgb * (a / 255.0), a], axis=-1)
    pre_img = Image.fromarray(premultiplied.astype(np.uint8), 'RGBA')
    # BOX (area-average) has no ringing/overshoot on hard edges, unlike
    # LANCZOS — important at the large supersample-to-16px ratio, where
    # LANCZOS left a visible ghost band under the text line and a faint
    # halo outside the rounded corners.
    resized = pre_img.resize((size, size), resample=Image.BOX)

    out = np.asarray(resized, dtype=np.float32)
    rgb_out, a_out = out[..., :3], out[..., 3:4]
    safe_a = np.where(a_out == 0, 1, a_out)
    unpremultiplied = np.clip(rgb_out / (safe_a / 255.0), 0, 255)
    final = np.concatenate([unpremultiplied, a_out], axis=-1)
    return Image.fromarray(final.astype(np.uint8), 'RGBA')


def make_pen_layer(pen_len, pen_w, outline_w, layer_size):
    img = Image.new('RGBA', (layer_size, layer_size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = layer_size / 2

    def draw_pen(w, length, color):
        radius = w / 2
        body_left = cx - length / 2
        body_right = cx + length / 2 - w * 0.9
        d.rounded_rectangle(
            [body_left, cy - w / 2, body_right, cy + w / 2],
            radius=radius, fill=color
        )
        tip = [
            (body_right - 1, cy - w / 2),
            (cx + length / 2, cy),
            (body_right - 1, cy + w / 2),
        ]
        d.polygon(tip, fill=color)

    draw_pen(pen_w + 2 * outline_w, pen_len + 2 * outline_w, GREEN)
    draw_pen(pen_w, pen_len, WHITE)
    return img


def make_icon(size, simplified):
    S = size * SUPERSAMPLE
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background: rounded square
    bg_radius = int(S * 0.20)
    draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=bg_radius, fill=GREEN)

    # White form card: middle 55%
    card_size = S * 0.55
    card_x0 = (S - card_size) / 2
    card_y0 = (S - card_size) / 2
    card_x1 = card_x0 + card_size
    card_y1 = card_y0 + card_size
    card_radius = card_size * 0.16
    draw.rounded_rectangle(
        [card_x0, card_y0, card_x1, card_y1], radius=card_radius, fill=WHITE
    )

    # Line(s) of "filled text" inside the card
    line_h = card_size * 0.10
    line_radius = line_h / 2
    pad_x = card_size * 0.16
    line1_x0 = card_x0 + pad_x
    line1_x1 = card_x1 - pad_x
    line1_y0 = card_y0 + card_size * (0.34 if simplified else 0.28)
    draw.rounded_rectangle(
        [line1_x0, line1_y0, line1_x1, line1_y0 + line_h],
        radius=line_radius, fill=GREEN
    )

    if not simplified:
        line2_y0 = line1_y0 + line_h + card_size * 0.14
        line2_x1 = line1_x0 + (line1_x1 - line1_x0) * 0.55
        line2_color = (GREEN[0], GREEN[1], GREEN[2], LINE2_ALPHA)
        draw.rounded_rectangle(
            [line1_x0, line2_y0, line2_x1, line2_y0 + line_h],
            radius=line_radius, fill=line2_color
        )

        # Pen crossing the bottom-right corner of the card, at 45 degrees
        pen_len = card_size * 0.92
        pen_w = card_size * 0.16
        outline_w = max(2, S * 0.006)
        layer_size = int(pen_len * 1.6)

        pen_layer = make_pen_layer(pen_len, pen_w, outline_w, layer_size)
        rotated = pen_layer.rotate(-45, resample=Image.BICUBIC, expand=True)

        px = int(card_x1 - rotated.width / 2)
        py = int(card_y1 - rotated.height / 2)
        img.alpha_composite(rotated, (px, py))

    return resize_rgba(img, size)


if __name__ == '__main__':
    make_icon(16, simplified=True).save('icons/icon16.png')
    make_icon(48, simplified=False).save('icons/icon48.png')
    make_icon(128, simplified=False).save('icons/icon128.png')
    print('done')
