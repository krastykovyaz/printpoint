# Puts one photo (JPG, PNG, WEBP) on an A4 page, scaled to fit with a margin. Usage: python3 -I image_to_pdf.py <in> <out.pdf>
import sys
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 60_000_000
DPI = 150
PAGE = (round(8.27 * DPI), round(11.69 * DPI))
MARGIN = round(0.4 * DPI)

with Image.open(sys.argv[1]) as photo:
    photo = ImageOps.exif_transpose(photo)
    if photo.mode in ("RGBA", "LA", "P"):
        photo = photo.convert("RGBA")
        flat = Image.new("RGB", photo.size, "white")
        flat.paste(photo, mask=photo.split()[-1])
        photo = flat
    photo = photo.convert("RGB")
    landscape = photo.width > photo.height
    size = (PAGE[1], PAGE[0]) if landscape else PAGE
    photo.thumbnail((size[0] - 2 * MARGIN, size[1] - 2 * MARGIN))
    page = Image.new("RGB", size, "white")
    page.paste(photo, ((size[0] - photo.width) // 2, (size[1] - photo.height) // 2))
    page.save(sys.argv[2], "PDF", resolution=DPI)
