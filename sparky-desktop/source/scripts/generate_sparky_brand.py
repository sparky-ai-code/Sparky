from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "prod"
SOURCE = OUTPUT / "sparky-logo-source.png"
SIZES = (16, 24, 32, 48, 64, 128, 256)
VISIBLE_ALPHA_THRESHOLD = 2


def visible_alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    # Ignore single-value alpha fringe pixels. The approved source has one far
    # outside the visible mark; retaining it shifts the low-resolution ICOs.
    alpha = image.getchannel("A")
    return alpha.point(lambda value: 255 if value >= VISIBLE_ALPHA_THRESHOLD else 0).getbbox()


def assert_centered(image: Image.Image) -> None:
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise RuntimeError("Generated icon has no visible pixels")
    center_x = (bbox[0] + bbox[2]) / 2
    center_y = (bbox[1] + bbox[3]) / 2
    expected_center = image.width / 2
    if abs(center_x - expected_center) > 1 or abs(center_y - expected_center) > 1:
        raise RuntimeError(f"Generated icon is not centered: {bbox}")


def render(size: int) -> Image.Image:
    with Image.open(SOURCE) as source:
        image = source.convert("RGBA")
    bbox = visible_alpha_bbox(image)
    if bbox is not None:
        image = image.crop(bbox)
    target_size = max(1, round(size * 0.9))
    scale = min(target_size / image.width, target_size / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def render_micro(size: int) -> Image.Image:
    return render(size)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    icon_1024 = render(1024)
    assert_centered(icon_1024)
    for name in ("sparky-ios-1024.png", "sparky-macos-1024.png", "sparky-universal-1024.png"):
        icon_1024.save(OUTPUT / name, optimize=True)
    render_micro(180).save(OUTPUT / "sparky-web-apple-touch-180.png", optimize=True)
    render_micro(16).save(OUTPUT / "sparky-web-favicon-16x16.png", optimize=True)
    render_micro(32).save(OUTPUT / "sparky-web-favicon-32x32.png", optimize=True)
    ico_images = [render_micro(size) if size <= 64 else render(size) for size in SIZES]
    for icon in ico_images:
        assert_centered(icon)
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
