"""Generate newsticker app icon at multiple sizes for .ico"""
from PIL import Image, ImageDraw

CATEGORY_COLORS = [
    '#4fc3f7',  # global – blue
    '#ff6b6b',  # breaking – red
    '#66bb6a',  # science – green
    '#ffa726',  # interests – orange
    '#ab47bc',  # future – purple
]

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Scaling factor
    s = size / 256

    # Background: dark rounded rectangle
    corner = int(48 * s)
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=corner,
        fill='#0d1117',
        outline='#30363d',
        width=max(1, int(2 * s)),
    )

    # Headline bars with colored indicators
    margin_x = int(40 * s)
    indicator_w = int(10 * s)
    bar_h = int(24 * s)
    gap = int(12 * s)
    bar_radius = int(4 * s)
    total_h = len(CATEGORY_COLORS) * bar_h + (len(CATEGORY_COLORS) - 1) * gap
    start_y = (size - total_h) // 2

    for i, color in enumerate(CATEGORY_COLORS):
        y = start_y + i * (bar_h + gap)

        # Colored indicator bar on the left
        draw.rounded_rectangle(
            [margin_x, y, margin_x + indicator_w, y + bar_h],
            radius=max(1, int(3 * s)),
            fill=color,
        )

        # Gray content bar (the "headline")
        bar_x = margin_x + indicator_w + int(8 * s)
        # Vary bar widths to look like different headline lengths
        widths = [0.92, 0.78, 0.85, 0.70, 0.80]
        bar_end = margin_x + int((size - 2 * margin_x) * widths[i])
        draw.rounded_rectangle(
            [bar_x, y + int(4 * s), bar_end, y + int(12 * s)],
            radius=bar_radius,
            fill='#e8e8e8',
        )
        # Smaller "description" bar underneath
        desc_end = margin_x + int((size - 2 * margin_x) * widths[i] * 0.7)
        draw.rounded_rectangle(
            [bar_x, y + int(15 * s), desc_end, y + int(21 * s)],
            radius=bar_radius,
            fill='#555555',
        )

    return img


# Generate at all standard ICO sizes
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [draw_icon(s) for s in sizes]

# Save as .ico (multi-size)
images[-1].save(
    'assets/icon.ico',
    format='ICO',
    sizes=[(s, s) for s in sizes],
    append_images=images[:-1],
)

# Also save 256px PNG for electron-builder
images[-1].save('assets/icon.png', format='PNG')

print(f'Generated icon.ico ({len(sizes)} sizes) and icon.png')
