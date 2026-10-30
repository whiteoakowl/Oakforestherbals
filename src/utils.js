'use strict';
const crypto = require('node:crypto');
const { get } = require('./db');

// Money is stored as integer cents everywhere.
function formatMoney(cents, symbol = '$') {
  const n = (Number(cents) || 0) / 100;
  const sign = n < 0 ? '-' : '';
  return sign + symbol + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "12.5" -> 1250; blank -> null (so optional prices stay empty).
function parseMoney(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function centsToInput(cents) {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

function toInt(input, fallback = 0) {
  const n = parseInt(input, 10);
  return Number.isFinite(n) ? n : fallback;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

// Returns a handle unique within `table`, appending -2, -3... as needed.
async function uniqueHandle(table, desired, excludeId = 0) {
  const base = slugify(desired);
  let handle = base;
  for (let i = 2; await get(`SELECT 1 FROM ${table} WHERE handle = ? AND id != ?`, handle, excludeId); i++) {
    handle = `${base}-${i}`;
  }
  return handle;
}

function parseTags(input) {
  return [...new Set(String(input || '').split(',').map((t) => t.trim()).filter(Boolean))];
}

function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatDate(value, withTime = false) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(value);
  const opts = { year: 'numeric', month: 'short', day: 'numeric' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString('en-US', opts);
}

function paginate(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, toInt(page, 1)), pages);
  return { total, pages, page: current, perPage, offset: (current - 1) * perPage };
}

function csvRow(values) {
  return values.map((v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

// Minimal RFC 4180 parser for product CSV imports.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter((r) => r.some((v) => v !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// Form arrays may arrive as arrays, index-keyed objects (qs with large indices) or a single value.
function asList(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return v === undefined || v === null || v === '' ? [] : [v];
}

// Rows keyed by record id are posted as field[id123] so qs/multer keep them as object keys
// (purely numeric keys get compacted into arrays).
const idFromKey = (key) => toInt(String(key).replace(/^id/, ''));

// Value for an <input type="datetime-local"> (UTC).
const toDateTimeInput = (value) => (value ? new Date(value).toISOString().slice(0, 16) : '');

const asBool = (v) => v === true || v === 'on' || v === '1' || v === 'true' || v === 1;

module.exports = {
  formatMoney, parseMoney, centsToInput, toInt, slugify, uniqueHandle, parseTags, token,
  escapeHtml, stripHtml, formatDate, paginate, csvRow, parseCsv, asBool, asList, idFromKey, toDateTimeInput,
};
