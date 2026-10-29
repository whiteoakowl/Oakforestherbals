'use strict';
// Derives readable companion colors from theme colors, so light brand colors stay accessible:
// "on" colors are text placed on a filled brand color; "ink" colors are the brand hue darkened
// until it reads as text on the page background (WCAG 4.5:1).

const DARK_TEXT = '#1a1a1a';

function toRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h.padEnd(6, '0'), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// White or near-black, whichever reads better on `bg`.
function onColor(bg) {
  return contrast(bg, '#ffffff') >= contrast(bg, DARK_TEXT) ? '#ffffff' : DARK_TEXT;
}

// Darkens `color` toward black until it reaches `min` contrast against `bg`.
function ink(color, bg, min = 4.5) {
  const rgb = toRgb(color);
  for (let t = 0; t <= 1; t += 0.05) {
    const candidate = toHex(rgb.map((v) => v * (1 - t)));
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return DARK_TEXT;
}

function themeColors(theme) {
  return {
    onPrimary: onColor(theme.color_primary),
    onAccent: onColor(theme.color_accent),
    primaryInk: ink(theme.color_primary, theme.color_background),
    accentInk: ink(theme.color_accent, theme.color_background),
  };
}

module.exports = { contrast, onColor, ink, themeColors };
