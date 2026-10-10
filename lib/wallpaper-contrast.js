// Sample the visible cover crop, keeping bright areas from disappearing into an
// overall dark average. Unreadable cross-origin images retain the safe shadow.
export function wallpaperBrightness(image, width, height) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * 1.035;
    const sw = width / scale, sh = height / scale;
    context.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, 0, 0, 32, 32);
    const { data } = context.getImageData(0, 0, 32, 32);
    const values = [];
    for (let i = 0; i < data.length; i += 4) values.push((data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722) / 255);
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length * .9)];
  } catch { return null; }
}

export function wallpaperTextShadow(text, brightness, dim = 0, frost = 0) {
  if (text === 'dark') return '0 1px 2px #ffffffd9, 0 0 7px #ffffff9e';
  const visible = brightness == null ? null : (brightness * (1 - frost) + frost) * (1 - dim);
  return visible != null && visible < .43 ? 'none' : '0 1px 3px #071522b3, 0 2px 9px #07152280';
}
