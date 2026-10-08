import loggerFactory from './logger.js';

export const DEFAULT_SELECTABLE_PROPS = ['id', 'created_at', 'updated_at'];
export const DEFAULT_REQUEST_TIMEOUT = 10000;

export const defineSelectableProps = (selectableProps, defaultProps = DEFAULT_SELECTABLE_PROPS) => {
  if (!selectableProps || !selectableProps.length) {
    return [...defaultProps];
  }
  if (selectableProps.length === 1 && selectableProps[0] === '*') {
    return selectableProps;
  }
  return [...new Set([...defaultProps, ...selectableProps])];
};

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isPlainObject = value => {
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
 * Validates a WHERE object: plain object, column-name keys and supported values only.
 *
 * @param {object} where
 * @returns {object} a shallow copy safe to pass to knex `.where()`
 */
export const validateWhere = where => {
  if (!isPlainObject(where)) {
    throw new TypeError('where must be a plain object');
  }
  const filters = {};
  for (const [column, value] of Object.entries(where)) {
    if (!COLUMN_NAME.test(column)) {
      throw new TypeError(`Invalid column name "${column}"`);
    }
    if (!isAllowedValue(value)) {
      throw new TypeError(`Invalid value for column "${column}"`);
    }
    filters[column] = value;
  }
  return filters;
};

// Only non-sensitive connection details are logged (never user/password).
const connectionDetails = (knexConfig = {}, tableName) => {
  const { connection } = knexConfig;
  const details = { client: knexConfig.client, table: tableName };

  if (connection && typeof connection === 'object') {
    details.host = connection.host;
    details.port = connection.port;
    details.database = connection.database;
  }
  return details;
};

/**
 * Creates a model bound to a single table, initiating and verifying the DB connection.
 *
 * @param {object} options
 * @param {Function} options.knex - the knex module (called with knexConfig) or an existing knex instance
 * @param {object} options.knexConfig - knex config for the connection, from the consuming service
 * @param {string} options.tableName - table to interact with
 * @param {number} [options.requestTimeout] - query timeout in ms
 * @param {string[]} [options.selectableProps] - columns to select, appended to the defaults
 * @param {import('winston').Logger} [options.logger]
 * @returns {Promise<object>}
 */
export default async function createModel({
  knex,
  knexConfig,
  tableName,
  requestTimeout = DEFAULT_REQUEST_TIMEOUT,
  selectableProps,
  logger = loggerFactory()
} = {}) {
  if (typeof knex !== 'function') {
    throw new TypeError('createModel: a knex connection must be provided');
  }
  if (!knexConfig || typeof knexConfig !== 'object') {
    throw new TypeError('createModel: a knex config must be provided');
  }
  if (!tableName || typeof tableName !== 'string') {
    throw new TypeError('createModel: a tableName must be provided');
  }

  const details = connectionDetails(knexConfig, tableName);
  logger.info('Attempting DB connection', details);

  let db;
  let tableExists;
  try {
    // A knex instance exposes `client`; the knex module itself does not.
    db = knex.client ? knex : knex(knexConfig);

    await db.raw('select 1').timeout(requestTimeout);
    tableExists = await db.schema.hasTable(tableName);
  } catch (error) {
    logger.error('DB connection error', { ...details, error: error.message });
    throw error;
  }

  if (!tableExists) {
    const error = new Error(`Table "${tableName}" does not exist`);
    logger.warn('DB connection failed', { ...details, error: error.message });
    throw error;
  }

  logger.info('DB connection successful', details);

  const props = defineSelectableProps(selectableProps);

  /**
   * Fetches all rows from the model's table matching every key/value in `where`.
   *
   * @param {object} [where] - e.g. { email: 'test@example.com' }; `{}` returns all rows
   * @returns {Promise<object[]>}
   */
  const get = async (where = {}) => {
    const filters = validateWhere(where);
    try {
      return await db.select(props).from(tableName).where(filters).timeout(requestTimeout);
    } catch (error) {
      // Filter values may contain personal data, so only the column names are logged.
      logger.error('DB read error', { table: tableName, columns: Object.keys(filters), error: error.message });
      throw error;
    }
  };

  return {
    knex: db,
    tableName,
    requestTimeout,
    selectableProps: props,
    logger,
    get
  };
}

export { createModel };
