# Prints the page count a Word (.docx) file declares about itself (Word writes it into docProps/app.xml).
# Prints nothing when the file does not say. Usage: python3 -I docx_pages.py <file>
import re
import sys
import zipfile

try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        info = archive.getinfo("docProps/app.xml")
        if info.file_size <= 200_000:
            match = re.search(rb"<Pages>(\d{1,4})</Pages>", archive.read(info))
            if match and int(match.group(1)) > 0:
                print(int(match.group(1)))
except Exception:
    pass
