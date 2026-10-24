# Sending a CV from tsech.online to Print Point

Print Point accepts a finished PDF from `https://tsech.online` when tsech.online opens it in a new window.
Nothing is uploaded to Print Point until the customer submits an order.

## Add this to the page that shows the finished CV

`getPdfBlob()` is yours: it must return a `Blob` (or `File`) holding the PDF, from memory or fetched from your own download link.

```html
<button id="print-cv" type="button">Print this CV</button>

<script>
  const PRINT_URL = "https://print.unilu.space/?lang=en";
  const PRINT_ORIGIN = "https://print.unilu.space";

  document.querySelector("#print-cv").addEventListener("click", () => {
    // Must run inside the click, or the browser blocks the new window.
    // Do not add "noopener": Print Point needs the link back to this window.
    const printWindow = window.open(PRINT_URL, "_blank");
    if (!printWindow) { window.location.href = PRINT_URL; return; } // blocked: customer attaches the file by hand

    const onMessage = async (event) => {
      if (event.origin !== PRINT_ORIGIN || event.source !== printWindow) return;
      if (event.data?.type !== "printpoint-ready") return;
      window.removeEventListener("message", onMessage);
      const pdf = await getPdfBlob();
      printWindow.postMessage(
        { type: "printpoint-cv", filename: "resume.pdf", file: pdf },
        PRINT_ORIGIN
      );
    };
    window.addEventListener("message", onMessage);
  });
</script>
```

## Notes

- Keep the button visible next to the normal "Download PDF" button: if the window cannot be linked (same-tab navigation, some in-app browsers), the customer downloads and attaches the file as before.
- Print Point checks the file starts with `%PDF-` and is at most 10 MB; anything else is ignored.
- The message is only delivered to Print Point if the window really is `https://print.unilu.space`, because of the `PRINT_ORIGIN` argument.
- Do not set a `Cross-Origin-Opener-Policy: same-origin` header on the page with this button; it cuts the link between the windows.
