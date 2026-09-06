from pathlib import Path
import re

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "prod"
SOURCE = OUTPUT / "sparky-logo.svg"
SIZES = (16, 24, 32, 48, 64, 128, 256)
SOURCE_SIZE = 600
SUPERSAMPLE = 4
SPARKY_BLUE = "#00B2FF"
MICRO_SOURCE_SIZE = 64
MICRO_SUPERSAMPLE = 16


def read_halftone_rectangles() -> list[tuple[int, int, int, int]]:
    source = SOURCE.read_text(encoding="utf-8")
    rectangles = [
        tuple(map(int, match))
        for match in re.findall(r"M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z", source)
    ]
    if not rectangles:
        raise RuntimeError(f"No halftone rectangles found in {SOURCE}")
    return [(x, y, width, height) for x, y, width, height, closing_width in rectangles if width == closing_width]


RECTANGLES = read_halftone_rectangles()


def render(size: int) -> Image.Image:
    canvas_size = SOURCE_SIZE * SUPERSAMPLE
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for x, y, width, height in RECTANGLES:
        left = x * SUPERSAMPLE
        top = y * SUPERSAMPLE
        right = (x + width) * SUPERSAMPLE - 1
        bottom = (y + height) * SUPERSAMPLE - 1
        draw.rectangle((left, top, right, bottom), fill=SPARKY_BLUE)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def render_micro(size: int) -> Image.Image:
    """Render a dot-preserving variant for UI and favicon sizes.

    The original mark has a five-unit grid in a 600-unit canvas. Below roughly
    64 px those cells are sub-pixel and antialias into a smooth gradient. This
    version intentionally uses an eight-unit grid in a 64-unit canvas so every
    halftone dot remains individually legible.
    """
    scale = MICRO_SUPERSAMPLE
    image = Image.new(
        "RGBA",
        (MICRO_SOURCE_SIZE * scale, MICRO_SOURCE_SIZE * scale),
        (0, 0, 0, 0),
    )
    draw = ImageDraw.Draw(image)
    center = 32
    sphere_radius = 29
    for y in range(4, MICRO_SOURCE_SIZE, 8):
        for x in range(4, MICRO_SOURCE_SIZE, 8):
            if (x - center) ** 2 + (y - center) ** 2 > sphere_radius**2:
                continue
            fade_position = max(0.0, min(1.0, ((x + y) / 2 - 10) / 48))
            opacity = round(255 * (1.0 - 0.62 * fade_position**2))
            radius = 2.65 * scale
            draw.ellipse(
                (
                    x * scale - radius,
                    y * scale - radius,
                    x * scale + radius,
                    y * scale + radius,
                ),
                fill=(0, 178, 255, opacity),
            )
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    icon_1024 = render(1024)
    for name in ("sparky-ios-1024.png", "sparky-macos-1024.png", "sparky-universal-1024.png"):
        icon_1024.save(OUTPUT / name, optimize=True)
    render_micro(180).save(OUTPUT / "sparky-web-apple-touch-180.png", optimize=True)
    render_micro(16).save(OUTPUT / "sparky-web-favicon-16x16.png", optimize=True)
    render_micro(32).save(OUTPUT / "sparky-web-favicon-32x32.png", optimize=True)
    ico_images = [render_micro(size) if size <= 64 else render(size) for size in SIZES]
    ico_images[-1].save(
        OUTPUT / "sparky-windows.ico",
        format="ICO",
        append_images=ico_images[:-1],
        sizes=[(size, size) for size in SIZES],
    )
    ico_images[-1].save(
        OUTPUT / "sparky-web-favicon.ico",
        format="ICO",
        append_images=ico_images[:-1],
        sizes=[(size, size) for size in SIZES],
    )


if __name__ == "__main__":
    main()
