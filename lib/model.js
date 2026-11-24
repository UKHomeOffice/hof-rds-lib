import loggerFactory from './logger.js';
import {
  connectionDetails,
  COLUMN_NAME,
  defineSelectableProps,
  isPlainObject,
  validateColumnValues,
  DEFAULT_SELECTABLE_PROPS
} from './model-helpers.js';

export const DEFAULT_REQUEST_TIMEOUT = 10000;
export { DEFAULT_SELECTABLE_PROPS, defineSelectableProps, validateColumnValues };

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

  const details = connectionDetails(tableName, knexConfig);
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
    const filters = validateColumnValues(where);
    try {
      return await db.select(props).from(tableName).where(filters).timeout(requestTimeout);
    } catch (error) {
      // Filter values may contain personal data, so only the column names are logged.
      logger.error('DB read error', { table: tableName, columns: Object.keys(filters), error: error.message });
      throw error;
    }
  };

  const getInTimeRange = async options => {
    if (!isPlainObject(options)) {
      throw new TypeError('time range options must be a plain object');
    }
    const { timestamp, from, to, withValue, selectableProps: selection } = options;
    const validateColumn = column => {
      if (typeof column !== 'string' || !COLUMN_NAME.test(column)) {
        throw new TypeError('time range columns must be valid column names');
      }
    };
    const validateDate = (value, name) => {
      if (!(value instanceof Date) && (typeof value !== 'string' || value.trim() === '')) {
        throw new TypeError(`${name} must be a valid Date or date string`);
      }
      const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
      if (!Number.isFinite(milliseconds)) {
        throw new TypeError(`${name} must be a valid Date or date string`);
      }
      return milliseconds;
    };

    validateColumn(timestamp);
    const start = validateDate(from, 'from');
    if (to !== undefined && validateDate(to, 'to') < start) {
      throw new TypeError('to must be on or after from');
    }
    if (withValue !== undefined) {
      validateColumn(withValue);
    }
    let columns = props;
    if (selection !== undefined) {
      if (typeof selection !== 'string' || selection.trim() === '') {
        throw new TypeError('selectableProps must be a comma-separated string of column names');
      }
      const selected = selection.split(',').map(column => column.trim());
      if (!(selected.length === 1 && selected[0] === '*')) {
        selected.forEach(validateColumn);
      }
      columns = defineSelectableProps(selected);
    }

    try {
      const query = db.select(columns).from(tableName);
      if (withValue !== undefined) {
        query.whereNotNull(withValue);
      }
      return await query.whereBetween(timestamp, [from, to === undefined ? db.fn.now() : to])
        .timeout(requestTimeout);
    } catch (error) {
      logger.error('DB time range read error', { table: tableName, code: error.code });
      throw error;
    }
  };

  /**
   * Counts rows matching every key/value in `where`; omitted filters count all rows.
   *
   * @param {object} [where]
   * @returns {Promise<number>}
   */
  const getCount = async (where = {}) => {
    const filters = validateColumnValues(where);
    try {
      const [result] = await db(tableName).count({ count: '*' }).where(filters).timeout(requestTimeout);
      return Number(result.count);
    } catch (error) {
      logger.error('DB count error', { table: tableName, columns: Object.keys(filters), code: error.code });
      throw error;
    }
  };

  /**
   * Returns size metrics for the model's table and database, and the number of rows matching `where`.
   *
   * @param {object} [where] - row_count filters, as for getCount; `{}` counts all rows
   * @returns {Promise<{table_name: string, table_size: string, database_name: string,
   *   database_size: string, row_count: number}>}
   */
  const getMetrics = async (where = {}) => {
    const filters = validateColumnValues(where);
    try {
      const [sizes, [result]] = await Promise.all([
        db('pg_catalog.pg_stat_user_tables')
          // knex has no builder for PostgreSQL functions, so these fragments take identifiers as bindings only.
          .first({
            table_size: db.raw('pg_size_pretty(pg_total_relation_size(??))', ['relid']),
            database_name: db.raw('current_database()'),
            database_size: db.raw('pg_size_pretty(pg_database_size(current_database()))')
          })
          .where({ relname: tableName })
          .andWhere('schemaname', db.raw('current_schema()'))
          .timeout(requestTimeout),
        db(tableName).count({ count: '*' }).where(filters).timeout(requestTimeout)
      ]);
      if (!sizes) {
        throw new Error(`Metrics for table "${tableName}" not found`);
      }
      return {
        table_name: tableName,
        table_size: sizes.table_size,
        database_name: sizes.database_name,
        database_size: sizes.database_size,
        row_count: Number(result.count)
      };
    } catch (error) {
      logger.error('DB metrics error', { table: tableName, columns: Object.keys(filters), code: error.code });
      throw error;
    }
  };

  /**
   * Updates the row with the given id and returns the updated rows' selectable props.
   *
   * @param {string|number} id
   * @param {object} fields - columns to update, e.g. { email: 'new@example.com' }
   * @returns {Promise<object[]>} empty if no row matched
   */
  const patch = async (id, fields) => {
    if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && !Number.isFinite(id))) {
      throw new TypeError('id must be a string or finite number');
    }
    const updates = validateColumnValues(fields, true);

    try {
      return await db(tableName)
        .where({ id })
        .update({ ...updates, updated_at: db.fn.now() })
        .returning(props)
        .timeout(requestTimeout);
    } catch (error) {
      logger.error('DB update error', { table: tableName, columns: Object.keys(updates), code: error.code });
      throw error;
    }
  };

  /**
   * Inserts a new row into the model's table with the specified data.
   *
   * @param {object} [data] - e.g. { email: 'test@example.com', id: 1 }
   * @returns {Promise<object[]>}
   */
  const create = async data => {
    const validatedData = validateColumnValues(data, true);
    try {
      return await db.insert(validatedData)
        .returning(props)
        .into(tableName)
        .timeout(requestTimeout);
    } catch (error) {
      logger.error('DB create error', { table: tableName, columns: Object.keys(data), code: error.code });
      throw error;
    }
  };

  /**
   * Deletes the row with the given id from the model's table.
   *
   * @param {number|string} id - a positive integer or non-empty string id
   * @returns {Promise<number>} the number of rows deleted
   */
  const deleteById = async id => {
    const isValidId = (Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && id.trim() !== '');
    if (!isValidId) {
      throw new TypeError('id must be a positive integer or non-empty string');
    }
    try {
      return await db(tableName).where({ id }).del().timeout(requestTimeout);
    } catch (error) {
      logger.error('DB delete error', { table: tableName, code: error.code });
      throw error;
    }
  };

  return {
    knex: db,
    tableName,
    requestTimeout,
    selectableProps: props,
    logger,
    get,
    getInTimeRange,
    getCount,
    getMetrics,
    patch,
    create,
    delete: deleteById
  };
}

export { createModel };
