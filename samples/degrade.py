#!/usr/bin/env python3
"""Turn a rendered licence PDF into something that looks photographed, not exported.

The clean specimens are digital PDFs, which any competent vision model reads
perfectly — as it should. But a large share of real trade licences arrive as a
photograph taken on a phone in an office: skewed, unevenly lit, noisy, and
JPEG-compressed to death, with the seal sitting over the text.

That is where extraction actually fails, so the demo needs one. Everything here
is a physical effect of photographing paper — rotation, perspective, glare,
sensor noise, compression. No text is altered and no field is falsified; the
document underneath is the same synthetic licence.

    ./samples/degrade.py in.pdf out.jpg
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

# Fixed seed: the sample must be identical on every regeneration, or the stub
# fixtures keyed by file hash would drift.
RNG = np.random.default_rng(20260813)


def render(pdf: Path, dpi: int = 150) -> Image.Image:
    out = pdf.with_suffix("")
    subprocess.run(
        ["pdftoppm", "-png", "-r", str(dpi), "-f", "1", "-l", "1", str(pdf), str(out)],
        check=True,
        capture_output=True,
    )
    page = out.with_name(f"{out.name}-1.png")
    image = Image.open(page).convert("RGB")
    page.unlink()
    return image


def perspective(image: Image.Image, shift: float = 0.012) -> Image.Image:
    """A page photographed off-axis, not scanned flat."""
    w, h = image.size
    dx, dy = w * shift, h * shift
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [(dx, dy * 0.6), (w - dx * 0.4, 0), (w, h - dy), (dx * 0.5, h)]

    # Solve for the 8 perspective coefficients mapping dst -> src.
    matrix = []
    for (sx, sy), (tx, ty) in zip(src, dst):
        matrix.append([tx, ty, 1, 0, 0, 0, -sx * tx, -sx * ty])
        matrix.append([0, 0, 0, tx, ty, 1, -sy * tx, -sy * ty])
    coeffs = np.linalg.solve(np.array(matrix, dtype=float), np.array(src, dtype=float).ravel())

    return image.transform(image.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(246, 244, 238))


def lighting(image: Image.Image) -> Image.Image:
    """Uneven overhead light: brighter top-left, falling off to the lower right."""
    w, h = image.size
    y, x = np.mgrid[0:h, 0:w]
    gradient = 1.06 - 0.30 * ((x / w) * 0.6 + (y / h) * 0.4)

    # A soft specular blob where the ceiling light reflects off the paper.
    glare = 0.16 * np.exp(-(((x - w * 0.68) ** 2) / (2 * (w * 0.16) ** 2)
                            + ((y - h * 0.22) ** 2) / (2 * (h * 0.10) ** 2)))

    arr = np.asarray(image, dtype=np.float32) * (gradient + glare)[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def paper_tone(image: Image.Image) -> Image.Image:
    """Office paper under warm light is not white."""
    arr = np.asarray(image, dtype=np.float32)
    arr *= np.array([1.0, 0.985, 0.94], dtype=np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def sensor_noise(image: Image.Image, sigma: float = 5.5) -> Image.Image:
    arr = np.asarray(image, dtype=np.float32)
    arr += RNG.normal(0.0, sigma, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1

    source, target = Path(sys.argv[1]), Path(sys.argv[2])

    image = render(source)
    image = perspective(image)
    image = image.rotate(-1.4, resample=Image.BICUBIC, fillcolor=(246, 244, 238))

    # Hand-held: slight motion blur and a miss on focus.
    image = image.filter(ImageFilter.GaussianBlur(radius=0.9))

    image = lighting(image)
    image = paper_tone(image)
    image = ImageEnhance.Contrast(image).enhance(0.82)

    # Downsample as if framed loosely, then noise and compress.
    w, h = image.size
    image = image.resize((int(w * 0.62), int(h * 0.62)), Image.LANCZOS)
    image = sensor_noise(image)

    image.save(target, "JPEG", quality=32, optimize=True)
    print(f"  {target}  ({target.stat().st_size} bytes, {image.size[0]}x{image.size[1]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
