'use strict';

/**
 * Reusable date helpers for filters, reporting ranges, and API query parsing.
 *
 * Example:
 * const {
 *   startOfDay,
 *   endOfDay,
 *   toISODate,
 *   normalizeDateFilter,
 *   isBetween,
 * } = require('../utils/dateUtils');
 */

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function toDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date;
}

function cloneDate(value) {
  return new Date(value.getTime());
}

function toISODate(date) {
  const value = toDate(date);
  if (!value) return null;

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function toISOStringWithTime(date) {
  const value = toDate(date);
  if (!value) return null;

  return value.toISOString();
}

function startOfDay(date) {
  const value = toDate(date);
  if (!value) return null;

  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date) {
  const value = toDate(date);
  if (!value) return null;

  const next = new Date(value);
  next.setHours(23, 59, 59, 999);
  return next;
}

function startOfMonth(date) {
  const value = toDate(date);
  if (!value) return null;

  const next = new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
  return next;
}

function endOfMonth(date) {
  const value = toDate(date);
  if (!value) return null;

  const next = new Date(value.getFullYear(), value.getMonth() + 1, 0, 23, 59, 59, 999);
  return next;
}

function addDays(date, days) {
  const value = toDate(date);
  if (!value) return null;

  const next = cloneDate(value);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function addMonths(date, months) {
  const value = toDate(date);
  if (!value) return null;

  const next = cloneDate(value);
  next.setMonth(next.getMonth() + Number(months || 0));
  return next;
}

function diffInDays(startDate, endDate) {
  const start = toDate(startDate);
  const end = toDate(endDate);

  if (!start || !end) {
    return null;
  }

  const diff = end.getTime() - start.getTime();
  return Math.round(diff / DAY_IN_MS);
}

function isSameDay(a, b) {
  const left = toDate(a);
  const right = toDate(b);

  if (!left || !right) {
    return false;
  }

  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function isBetween(date, start, end, { inclusive = true } = {}) {
  const value = toDate(date);
  const startDate = toDate(start);
  const endDate = toDate(end);

  if (!value || !startDate || !endDate) {
    return false;
  }

  const time = value.getTime();
  const from = startDate.getTime();
  const to = endDate.getTime();

  if (inclusive) {
    return time >= from && time <= to;
  }

  return time > from && time < to;
}

function buildDateRange(from, to) {
  const start = toDate(from) || new Date(0);
  const end = toDate(to) || new Date();

  return {
    start: startOfDay(start),
    end: endOfDay(end),
  };
}

function normalizeDateFilter(filter = {}) {
  const {
    from,
    to,
    startDate,
    endDate,
    lastDays,
    month,
    year,
    includeTime = false,
  } = filter;

  const startValue = from || startDate || null;
  const endValue = to || endDate || null;

  if (month) {
    const monthDate = new Date(month);
    if (!Number.isNaN(monthDate.getTime())) {
      const rangeStart = startOfMonth(monthDate);
      const rangeEnd = endOfMonth(monthDate);

      return {
        start: includeTime ? rangeStart : startOfDay(rangeStart),
        end: includeTime ? rangeEnd : endOfDay(rangeEnd),
      };
    }
  }

  if (year) {
    const yearDate = new Date(`${year}-01-01T00:00:00.000Z`);
    if (!Number.isNaN(yearDate.getTime())) {
      const rangeStart = new Date(yearDate.getFullYear(), 0, 1, 0, 0, 0, 0);
      const rangeEnd = new Date(yearDate.getFullYear(), 11, 31, 23, 59, 59, 999);

      return {
        start: includeTime ? rangeStart : startOfDay(rangeStart),
        end: includeTime ? rangeEnd : endOfDay(rangeEnd),
      };
    }
  }

  if (lastDays) {
    const days = Number(lastDays);
    if (Number.isFinite(days) && days >= 0) {
      const today = startOfDay(new Date());
      const start = addDays(today, -days);
      return {
        start: includeTime ? start : startOfDay(start),
        end: includeTime ? endOfDay(new Date()) : endOfDay(new Date()),
      };
    }
  }

  if (startValue || endValue) {
    const start = toDate(startValue) || new Date(0);
    const end = toDate(endValue) || new Date();

    return {
      start: includeTime ? start : startOfDay(start),
      end: includeTime ? end : endOfDay(end),
    };
  }

  return {
    start: null,
    end: null,
  };
}

/**
 * Parses common date query strings in supported formats:
 * - YYYY-MM-DD
 * - YYYY-MM-DDTHH:mm:ss.sssZ
 * - ISO date strings
 *
 * Returns a Date or null.
 */
function parseDateInput(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = toDate(value);
  if (!parsed) return null;

  return parsed;
}

module.exports = {
  DAY_IN_MS,
  toDate,
  cloneDate,
  toISODate,
  toISOStringWithTime,
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  addDays,
  addMonths,
  diffInDays,
  isSameDay,
  isBetween,
  buildDateRange,
  normalizeDateFilter,
  parseDateInput,
};
