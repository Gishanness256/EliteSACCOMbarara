const XLSX = require('xlsx');
const { stringify } = require('csv-stringify/sync');
const { parse } = require('csv-parse/sync');

/**
 * Normalizes input so the util can work with:
 * - an array of objects
 * - { data: [...] }
 * - a single object
 * - an empty value
 */
function normalizeRows(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && Array.isArray(data.data)) {
    return data.data;
  }

  if (data && typeof data === 'object') {
    return [data];
  }

  return [];
}

/**
 * Returns the list of keys from all objects in a row set.
 * Useful for CSV/Excel exports with consistent columns.
 */
function getColumnNames(rows) {
  if (!rows.length) {
    return [];
  }

  const keys = new Set();

  rows.forEach((row) => {
    if (row && typeof row === 'object') {
      Object.keys(row).forEach((key) => keys.add(key));
    }
  });

  return [...keys];
}

/**
 * Convert JSON/array-of-objects to CSV string.
 *
 * Example:
 * jsonToCsv([{ name: 'John', amount: 100 }, { ... }])
 */
function jsonToCsv(data, options = {}) {
  const rows = normalizeRows(data);

  if (!rows.length) {
    return '';
  }

  const columns = options.columns || getColumnNames(rows);

  const normalizedRows = rows.map((row) => {
    const output = {};
    columns.forEach((column) => {
      const value = row[column];
      output[column] = value === undefined || value === null ? '' : value;
    });
    return output;
  });

  return stringify(normalizedRows, {
    header: options.includeHeader !== false,
    columns,
    delimiter: options.delimiter || ',',
    quoted: options.quoted ?? true,
    bom: options.bom ?? false,
    cast: {
      date: (value) => (value instanceof Date ? value.toISOString() : value),
      // eslint-disable-next-line no-unused-vars
      object: (value) => (typeof value === 'object' ? JSON.stringify(value) : value),
    },
  });
}

/**
 * Convert array-of-objects to an Excel workbook buffer (.xlsx).
 *
 * Example:
 * const buffer = jsonToExcelBuffer([{ id: 1, name: 'John' }]);
 */
function jsonToExcelBuffer(data, options = {}) {
  const rows = normalizeRows(data);

  if (!rows.length) {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, sheet, options.sheetName || 'Sheet1');
    return XLSX.write(workbook, {
      type: 'buffer',
      bookType: options.bookType || 'xlsx',
    });
  }

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    defval: '',
    skipHeader: false,
  });

  XLSX.utils.book_append_sheet(workbook, worksheet, options.sheetName || 'Sheet1');

  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: options.bookType || 'xlsx',
    compression: true,
  });
}

/**
 * Convert CSV string to JSON array.
 *
 * Example:
 * csvToJson("name,amount\nJohn,100\n")
 * -> [{ name: 'John', amount: '100' }]
 */
function csvToJson(csvString, options = {}) {
  if (!csvString || typeof csvString !== 'string') {
    return [];
  }

  const records = parse(csvString, {
    columns: options.columns ?? true,
    skip_empty_lines: options.skipEmptyLines ?? true,
    trim: options.trim ?? true,
    relax_column_count: options.relaxColumnCount ?? true,
    bom: options.bom ?? true,
    ...options.parseOptions,
  });

  return records;
}

/**
 * Convert an Excel file buffer to JSON array.
 *
 * Example:
 * const rows = excelToJson(buffer);
 */
function excelToJson(buffer, options = {}) {
  if (!buffer) {
    return [];
  }

  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: options.cellDates ?? true,
    raw: options.raw ?? false,
  });

  const sheetName = options.sheetName || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  if (!worksheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json(worksheet, {
    defval: '',
    raw: options.raw ?? false,
    dateNF: options.dateNF || 'yyyy-mm-dd',
  });
}

/**
 * Generic export wrapper to return the right payload for HTTP responses.
 *
 * Example:
 * const result = exportData({
 *   data: rows,
 *   format: 'csv',
 *   filename: 'members',
 * });
 *
 * result = {
 *   filename: 'members.csv',
 *   contentType: 'text/csv; charset=utf-8',
 *   data: 'name,...'
 * }
 */
function exportData({ data, format = 'json', filename = 'export', options = {} }) {
  const selectedFormat = String(format).toLowerCase();

  switch (selectedFormat) {
    case 'csv': {
      const csvData = jsonToCsv(data, options);
      return {
        filename: `${filename}.csv`,
        contentType: 'text/csv; charset=utf-8',
        data: csvData,
      };
    }

    case 'excel':
    case 'xlsx':
      return {
        filename: `${filename}.xlsx`,
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: jsonToExcelBuffer(data, options),
      };

    case 'json':
    default: {
      const jsonData =
        data && typeof data === 'string' ? data : JSON.stringify(data ?? [], null, options.pretty ? 2 : 0);

      return {
        filename: `${filename}.json`,
        contentType: 'application/json; charset=utf-8',
        data: jsonData,
      };
    }
  }
}

module.exports = {
  normalizeRows,
  getColumnNames,
  jsonToCsv,
  jsonToExcelBuffer,
  csvToJson,
  excelToJson,
  exportData,
};
