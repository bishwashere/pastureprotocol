import { basename, isAbsolute, win32 } from 'path';

function looksWindowsPath(value) {
  const s = String(value || '');
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.includes('\\');
}

export function isAbsoluteAnyPath(value) {
  const s = String(value || '');
  return isAbsolute(s) || win32.isAbsolute(s);
}

export function basenameAnyPath(value) {
  const s = String(value || '');
  if (!s) return '';
  return looksWindowsPath(s) ? win32.basename(s) : basename(s);
}
