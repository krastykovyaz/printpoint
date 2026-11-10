-- Used by convert.js: replaces every image with its caption text, so pandoc never reads a file or URL.
function Image(el)
  return el.caption
end
