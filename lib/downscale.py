# Shrinks a receipt image so large amounts become a size OCR reads reliably.
# Usage: python3 -I downscale.py <input> <output.png> <max width>
import sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs

source, target, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
image = Image.open(source)
image.load()
image = image.convert("RGB")  # flattens transparency and animation to one frame
if image.width > width:
    image = image.resize((width, max(1, round(image.height * width / image.width))), Image.LANCZOS)
image.save(target, "PNG")
print(image.width, image.height)
