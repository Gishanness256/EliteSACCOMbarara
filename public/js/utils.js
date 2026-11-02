(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const p2 = (n) => String(n ?? 0).padStart(2, '0');

  const iso = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  };

  const fmtD = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };

  const today = () => fmtD(new Date());

  const fmt = (value, currency = 'UGX') => {
    const n = Number(value) || 0;
    return `${currency} ${Math.round(n).toLocaleString()}`;
  };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));

  const parseNumber = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  const clamp = (value, min, max) => {
    const n = Number(value) || 0;
    return Math.min(Math.max(n, min), max);
  };

  const randomId = (prefix = 'id') => {
    const stamp = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${stamp}-${rnd}`;
  };

  const safeParse = (text, fallback = null) => {
    try {
      return text ? JSON.parse(text) : fallback;
    } catch (error) {
      return fallback;
    }
  };

  const saveJSON = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  };

  const loadJSON = (key, fallback = null) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? safeParse(raw, fallback) : fallback;
    } catch (error) {
      return fallback;
    }
  };

  const sum = (items, selector = (x) => x) =>
    (items || []).reduce((total, item) => total + (Number(selector(item)) || 0), 0);

  const unique = (items) => [...new Set(items.filter(Boolean))];

  const isEmpty = (value) =>
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

  const deepClone = (value) => {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  };

  const setStatus = (element, message, isError = false) => {
    if (!element) return;
    element.className = isError ? 'msg err' : 'msg';
    element.textContent = message || '';
  };

  const init = () => {
    const target = window.ESACCO || {};
    Object.assign(target, {
      $, $$,
      p2, iso, fmtD, today, fmt, esc,
      parseNumber, clamp, randomId,
      safeParse, saveJSON, loadJSON,
      sum, unique, isEmpty, deepClone, setStatus
    });
    window.ESACCO = target;
  };

  init();
})();
