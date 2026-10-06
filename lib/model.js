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

  return {
    knex: db,
    tableName,
    requestTimeout,
    selectableProps: defineSelectableProps(selectableProps),
    logger
  };
}

export { createModel };
