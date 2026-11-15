"""Grab the whole desktop and save it as a downscaled JPEG.

Usage: capture.py OUT_PATH [maxWidth] [quality]

Runs on the bundled DSH python (which ships Pillow). Stdout reports size;
a non-zero exit means the caller should try another interpreter.
"""

import os
import sys

from PIL import Image, ImageGrab


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: capture.py OUT [maxWidth] [quality]", file=sys.stderr)
        return 2
    out = sys.argv[1]
    max_width = int(sys.argv[2]) if len(sys.argv) > 2 else 1280
    quality = int(sys.argv[3]) if len(sys.argv) > 3 else 72

    image = ImageGrab.grab(all_screens=True)
    width, height = image.size
    if max_width > 0 and width > max_width:
        scale = max_width / width
        image = image.resize(
            (max(1, round(width * scale)), max(1, round(height * scale))),
            Image.Resampling.LANCZOS,
        )
    if image.mode != "RGB":
        image = image.convert("RGB")
    image.save(out, "JPEG", quality=quality, optimize=True)
    print("%d x %d, %d bytes" % (image.size[0], image.size[1], os.path.getsize(out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
