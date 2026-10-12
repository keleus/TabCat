// Icons never need more than a few hundred pixels. Shrinking them keeps both the
// local cache and uploaded images small.
export const ICON_IMAGE_SIZE = 256;

export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const type = /^data:([^;,]+)/.exec(dataUrl.slice(0, comma))?.[1] || 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Accepts a Blob or File and resolves to a WebP data URL no larger than
// `max` pixels on its long side; smaller images are never enlarged.
export async function resizeToDataUrl(source, { max = ICON_IMAGE_SIZE, limit = 200 * 1024 } = {}) {
  const bitmap = await createImageBitmap(source);
  try {
    if (bitmap.width * bitmap.height > 60000000) throw new Error('图片分辨率过大，请选择 6000 万像素以内的图片');
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.75, 0.6]) {
      const data = canvas.toDataURL('image/webp', quality);
      if (data.length <= limit) return data;
    }
    throw new Error('图片压缩后仍然过大，请选择较小的图片');
  } finally { bitmap.close(); }
}
