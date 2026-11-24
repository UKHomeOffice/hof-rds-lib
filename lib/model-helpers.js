export const DEFAULT_SELECTABLE_PROPS = ['id', 'created_at', 'updated_at'];

export const defineSelectableProps = (selectableProps, defaultProps = DEFAULT_SELECTABLE_PROPS) => {
  if (!selectableProps?.length) {
    return [...defaultProps];
  }
  if (selectableProps.length === 1 && selectableProps[0] === '*') {
    return selectableProps;
  }
  return [...new Set([...defaultProps, ...selectableProps])];
};

export const COLUMN_NAME = /^[A-Za-z_]\w*$/;

export const isPlainObject = value => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isAllowedValue = value =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (value instanceof Date && !Number.isNaN(value.getTime()));

/**
 * Validates an input object: plain object, column-name keys (at least one if required) and supported values only.
 *
 * @param {object} input
 * @param {boolean} [requireNonEmpty=false] - whether to require at least one column
 * @returns {object} a shallow copy safe to pass to knex `.insert()` or `.where()`
 */
export const validateColumnValues = (input, requireNonEmpty = false) => {
  if (!isPlainObject(input)) {
    throw new TypeError('input must be a plain object');
  }
  const entries = Object.entries(input);
  if (requireNonEmpty && entries.length === 0) {
    throw new TypeError('input must contain at least one column');
  }
  const validated = {};
  for (const [column, value] of entries) {
    if (!COLUMN_NAME.test(column)) {
      throw new TypeError(`Invalid column name "${column}"`);
    }
    if (!isAllowedValue(value)) {
      throw new TypeError(`Invalid value for column "${column}"`);
    }
    validated[column] = value;
  }
  return validated;
};

export const connectionDetails = (tableName, knexConfig = {}) => {
  const { connection } = knexConfig;
  const details = { client: knexConfig.client, table: tableName };

  if (connection && typeof connection === 'object') {
    details.host = connection.host;
    details.port = connection.port;
    details.database = connection.database;
  }
  return details;
};
