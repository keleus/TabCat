// An uploaded icon lives inline (a data URL) in this device's state. Browser
// sync and WebDAV refer to it by content instead, `tabcat-icon:<sha256>.<ext>`,
// so the same picture always has the same name and never conflicts.
const PREFIX = 'tabcat-icon:';
const TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', ico: 'image/x-icon' };
const EXTENSIONS = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
const REF = /^tabcat-icon:([0-9a-f]{64})\.(webp|png|jpg|gif|ico)$/;

export const isIconRef = value => typeof value === 'string' && REF.test(value);
export const isInlineImage = value => typeof value === 'string' && value.startsWith('data:image/');

// The file name on the WebDAV server.
export const iconRefFile = ref => ref.slice(PREFIX.length);

function decode(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  const ext = match && EXTENSIONS[match[1].toLowerCase()];
  if (!ext) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { ext, bytes };
}

export function iconImageBytes(dataUrl) {
  const decoded = decode(dataUrl);
  return decoded ? { bytes: decoded.bytes, type: TYPES[decoded.ext] } : null;
}

export async function iconRef(dataUrl) {
  const decoded = decode(dataUrl);
  if (!decoded) return '';
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', decoded.bytes));
  return `${PREFIX}${[...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')}.${decoded.ext}`;
}

// Rebuilds the picture from downloaded bytes, refusing anything that does not
// match its name: a damaged or substituted file is never shown.
export async function iconFromBytes(ref, bytes) {
  const [, , ext] = REF.exec(ref) || [];
  if (!ext) return '';
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const dataUrl = `data:${TYPES[ext]};base64,${btoa(binary)}`;
  return await iconRef(dataUrl) === ref ? dataUrl : '';
}

// Data URL -> ref for every uploaded icon in the given states.
export async function iconRefMap(...states) {
  const map = new Map();
  for (const state of states) for (const site of state?.sites || []) {
    if (isInlineImage(site.icon) && !map.has(site.icon)) {
      const ref = await iconRef(site.icon);
      if (ref) map.set(site.icon, ref);
    }
  }
  return map;
}
