const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'CONIN$', 'CONOUT$'
]);

export function safePath(inputName: string, fallback = 'download'): string {
  if (!inputName || typeof inputName !== 'string') {
    return fallback;
  }

  // Normalize Unicode NFC
  let cleaned = inputName.normalize('NFC');

  // [SEC-09] Decodifica sequências de escape URL em laço (até 3 iterações) até estabilizar
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(cleaned);
      if (decoded === cleaned) break;
      cleaned = decoded;
    } catch {
      break;
    }
  }

  // [SEC-14] Remove query parameters e fragmentos de hash que distorcem extensões
  cleaned = cleaned.split('?')[0].split('#')[0];

  // Strip null bytes and control chars (including RTL override U+202E)
  cleaned = cleaned.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/g, '');

  // Strip traversal patterns
  cleaned = cleaned.replace(/\.\.+/g, '');

  // Strip leading path separators / dots / underscores
  cleaned = cleaned.replace(/^[\\/._]+/, '');

  // Replace path separators with underscores
  cleaned = cleaned.replace(/[\\/]+/g, '_');

  // Strip characters forbidden in standard filenames
  cleaned = cleaned.replace(/[<>:"|?*]/g, '_');

  // Trim spaces and periods
  cleaned = cleaned.trim().replace(/^\.+|\.+$/g, '').replace(/^_+|_+$/g, '');

  if (!cleaned) {
    return fallback;
  }

  // Check windows reserved names
  // [SEC-08] Windows desconsidera espaços e pontos ao final do stem (ex: 'CON .txt' -> stem 'CON')
  const baseStem = cleaned.split('.')[0].trimEnd().toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(baseStem)) {
    cleaned = `_${cleaned}`;
  }

  // Max length truncation (100 chars)
  if (cleaned.length > 100) {
    const extIdx = cleaned.lastIndexOf('.');
    if (extIdx > 0 && cleaned.length - extIdx < 10) {
      const ext = cleaned.substring(extIdx);
      cleaned = cleaned.substring(0, 100 - ext.length) + ext;
    } else {
      cleaned = cleaned.substring(0, 100);
    }
  }

  return cleaned || fallback;
}
