import { expect, jest } from '@jest/globals';
import knex from 'knex';
import createModel, {
  DEFAULT_SELECTABLE_PROPS
} from '../../../lib/model.js';
import loggerFactory from '../../../lib/logger.js';

const knexConfig = {
  client: 'pg',
  connection: { host: 'localhost', port: 5432, database: 'test_db', user: 'user', password: 'secret' }
};
const loggedDetails = { client: 'pg', table: 'apps', host: 'localhost', port: 5432, database: 'test_db' };

describe('createModel', () => {
  const expectFirstCallStartsWith = (mock, ...args) => {
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0].slice(0, args.length)).toEqual(args);
  };
  let instances;
  let logger;
  let rawRestorers;

  // Real knex instance (no connection is made until a query runs) with only the DB round-trips stubbed.
  const stubbedKnex = ({ config = knexConfig, rawError, hasTable = true, hasTableError } = {}) => {
    const instance = knex(config);
    instances.push(instance);

    const timeout = rawError ? jest.fn().mockRejectedValue(rawError) : jest.fn().mockResolvedValue();
    const rawDescriptor = Object.getOwnPropertyDescriptor(instance, 'raw');
    const raw = jest.fn().mockReturnValue({ timeout });
    Object.defineProperty(instance, 'raw', { ...rawDescriptor, value: raw });
    rawRestorers.push(() => Object.defineProperty(instance, 'raw', rawDescriptor));
    const hasTableStub = hasTableError
      ? jest.fn().mockRejectedValue(hasTableError)
      : jest.fn().mockResolvedValue(hasTable);
    jest.spyOn(instance.client, 'schemaBuilder').mockReturnValue({ hasTable: hasTableStub });

    return { instance, raw, timeout, hasTable: hasTableStub };
  };

  const rejectionOf = promise => promise.then(() => expect.fail('expected promise to reject'), error => error);

  beforeEach(() => {
    instances = [];
    rawRestorers = [];
    logger = loggerFactory();
    jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'error');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    rawRestorers.forEach(restore => restore());
    await Promise.all(instances.map(instance => instance.destroy()));
  });

  describe('on a successful connection', () => {
    it('returns a model with defaults', async () => {
      const { instance } = stubbedKnex();
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps', logger });

      expect(model.knex).toBe(instance);
      expect(model.tableName).toBe('apps');
      expect(model.requestTimeout).toBe(10000);
      expect(model.selectableProps).toEqual(DEFAULT_SELECTABLE_PROPS);
      expect(model.logger).toBe(logger);
    });

    it('verifies the connection and table using the request timeout', async () => {
      const { instance, raw, timeout, hasTable } = stubbedKnex();
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps', requestTimeout: 2500, logger });

      expect(raw).toHaveBeenCalledTimes(1);
      expect(raw).toHaveBeenNthCalledWith(1, 'select 1');
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenNthCalledWith(1, 2500);
      expect(hasTable).toHaveBeenCalledTimes(1);
      expect(hasTable).toHaveBeenNthCalledWith(1, 'apps');
      expect(model.requestTimeout).toBe(2500);
    });

    it('applies custom selectable props on top of the defaults', async () => {
      const { instance } = stubbedKnex();
      const model = await createModel({
        knex: instance, knexConfig, tableName: 'apps', selectableProps: ['email', 'session'], logger
      });

      expect(model.selectableProps).toEqual([...DEFAULT_SELECTABLE_PROPS, 'email', 'session']);
    });

    it('logs the attempt and success with connection details but no credentials', async () => {
      const { instance } = stubbedKnex();
      await createModel({ knex: instance, knexConfig, tableName: 'apps', logger });

      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenNthCalledWith(1, 'Attempting DB connection', loggedDetails);
      expect(logger.info).toHaveBeenNthCalledWith(2, 'DB connection successful', loggedDetails);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not log a connection string', async () => {
      const config = { client: 'pg', connection: 'postgres://user:secret@localhost/test_db' };
      const { instance } = stubbedKnex({ config });
      await createModel({ knex: instance, knexConfig: config, tableName: 'apps', logger });

      for (const call of logger.info.mock.calls) {
        expect(call[1]).toEqual({ client: 'pg', table: 'apps' });
      }
    });

    it('uses the library logger by default', async () => {
      const { instance } = stubbedKnex();
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps' });

      expect(model.logger.logSession).toEqual(expect.any(Function));
    });
  });

  describe('on a failed connection', () => {
    it('logs and rethrows connection errors', async () => {
      const { instance } = stubbedKnex({ rawError: new Error('ECONNREFUSED') });
      const error = await rejectionOf(createModel({ knex: instance, knexConfig, tableName: 'apps', logger }));

      expect(error.message).toBe('ECONNREFUSED');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB connection error', { ...loggedDetails, error: 'ECONNREFUSED' }
      );
      expect(logger.error.mock.invocationCallOrder[0]).toBeGreaterThan(logger.info.mock.invocationCallOrder[0]);
    });

    it('logs and rethrows errors from the table check', async () => {
      const { instance } = stubbedKnex({ hasTableError: new Error('permission denied') });
      const error = await rejectionOf(createModel({ knex: instance, knexConfig, tableName: 'apps', logger }));

      expect(error.message).toBe('permission denied');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB connection error', { ...loggedDetails, error: 'permission denied' }
      );
    });

    it('logs a failure when the table does not exist', async () => {
      const { instance } = stubbedKnex({ hasTable: false });
      const error = await rejectionOf(createModel({ knex: instance, knexConfig, tableName: 'apps', logger }));

      expect(error.message).toBe('Table "apps" does not exist');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenNthCalledWith(1,
        'DB connection failed', { ...loggedDetails, error: 'Table "apps" does not exist' }
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs and rethrows errors from creating the knex instance', async () => {
      const badConfig = { client: 'not-a-real-client', connection: {} };
      const error = await rejectionOf(createModel({ knex, knexConfig: badConfig, tableName: 'apps', logger }));

      expect(error.message).toMatch(/Unknown configuration option 'client'/);
      expectFirstCallStartsWith(logger.info, 'Attempting DB connection');
      expectFirstCallStartsWith(logger.error, 'DB connection error');
    });
  });

  describe('get', () => {
    const rows = [{ id: 1, email: 'test@example.com' }];
    let instance;
    let run;
    let builder;

    // Captures the built query and stubs only its execution.
    const createGetModel = async (options = {}, { runError } = {}) => {
      ({ instance } = stubbedKnex());
      run = runError ? jest.fn().mockRejectedValue(runError) : jest.fn().mockResolvedValue(rows);
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('selects the selectable props from the table matching the where object', async () => {
      const model = await createGetModel({ selectableProps: ['email'] });
      const result = await model.get({ email: 'test@example.com' });
      const { sql, bindings } = builder.toSQL();

      expect(result).toEqual(rows);
      expect(sql).toBe('select "id", "created_at", "updated_at", "email" from "apps" where "email" = ?');
      expect(bindings).toEqual(['test@example.com']);
    });

    it('combines multiple criteria and handles nulls', async () => {
      const model = await createGetModel();
      await model.get({ email: 'test@example.com', id: 1, deleted_at: null });
      const { sql, bindings } = builder.toSQL();

      expect(sql).toBe(
        'select "id", "created_at", "updated_at" from "apps" where "email" = ? and "id" = ? and "deleted_at" is null'
      );
      expect(bindings).toEqual(['test@example.com', 1]);
    });

    it('returns all rows when no criteria are given', async () => {
      const model = await createGetModel();
      await model.get();

      expect(builder.toSQL().sql).toBe('select "id", "created_at", "updated_at" from "apps"');
    });

    it('binds values as parameters rather than inlining them', async () => {
      const model = await createGetModel();
      const malicious = "x' OR '1'='1";
      await model.get({ email: malicious });
      const { sql, bindings } = builder.toSQL();

      expect(sql).not.toContain(malicious);
      expect(bindings).toEqual([malicious]);
    });

    it('uses the request timeout', async () => {
      const model = await createGetModel({ requestTimeout: 1234 });
      await model.get({ id: 1 });

      expect(builder.toSQL().timeout).toBe(1234);
    });

    it('does not mutate the where object', async () => {
      const model = await createGetModel();
      const where = { id: 1 };
      await model.get(where);

      expect(where).toEqual({ id: 1 });
    });

    it('logs and rethrows query errors without logging filter values', async () => {
      const model = await createGetModel({}, { runError: new Error('query timed out') });
      const error = await rejectionOf(model.get({ email: 'test@example.com' }));

      expect(error.message).toBe('query timed out');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB read error', { table: 'apps', columns: ['email'], error: 'query timed out' }
      );
    });

    it('continues to work after an error', async () => {
      const model = await createGetModel();
      run.mockRejectedValueOnce(new Error('boom'));

      await rejectionOf(model.get({ id: 1 }));
      expect(await model.get({ id: 1 })).toEqual(rows);
    });

    it('rejects invalid input without querying the DB', async () => {
      const model = await createGetModel();

      for (const where of [null, 'id = 1', [], { 'id; drop table apps': 1 }, { email: { $ne: '' } }]) {
        expect(await rejectionOf(model.get(where))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('getInTimeRange', () => {
    const range = { timestamp: 'created_at', from: '2026-02-01', to: '2026-02-05' };
    const rows = [{ id: 1 }];
    let run;
    let builder;

    const createRangeModel = async (options = {}) => {
      const { instance } = stubbedKnex();
      run = jest.fn().mockResolvedValue(rows);
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('selects configured columns with inclusive parameterised bounds and the initialised timeout', async () => {
      const model = await createRangeModel({ selectableProps: ['email'], requestTimeout: 1234 });

      expect(await model.getInTimeRange(range)).toEqual(rows);
      expect(builder.toSQL().sql).toBe(
        'select "id", "created_at", "updated_at", "email" from "apps" where "created_at" between ? and ?'
      );
      expect(builder.toSQL().bindings).toEqual([range.from, range.to]);
      expect(builder.toSQL().timeout).toBe(1234);
    });

    it('defaults the upper bound to database time and supports a non-null column', async () => {
      const model = await createRangeModel();
      await model.getInTimeRange({ timestamp: 'updated_at', from: range.from, withValue: 'email' });

      expect(builder.toSQL().sql).toBe(
        'select "id", "created_at", "updated_at" from "apps" ' +
        'where "email" is not null and "updated_at" between ? and CURRENT_TIMESTAMP'
      );
      expect(builder.toSQL().bindings).toEqual([range.from]);
    });

    it('supports per-call selectableProps without changing the model or input', async () => {
      const model = await createRangeModel();
      const options = Object.freeze({ ...range, selectableProps: 'email, id' });
      await model.getInTimeRange(options);

      expect(builder.toSQL().sql).toContain('select "id", "created_at", "updated_at", "email" from');
      expect(model.selectableProps).toEqual(DEFAULT_SELECTABLE_PROPS);
      expect(options).toEqual({ ...range, selectableProps: 'email, id' });
      await model.getInTimeRange({ ...range, selectableProps: '*' });
      expect(builder.toSQL().sql).toContain('select * from');
    });

    it('accepts Date bounds, including equal bounds, and returns an empty result when nothing matches', async () => {
      const model = await createRangeModel();
      const date = new Date('2026-02-01T00:00:00Z');
      run.mockResolvedValue([]);

      expect(await model.getInTimeRange({ ...range, from: date, to: date })).toEqual([]);
      expect(builder.toSQL().bindings).toEqual([date, date]);
    });

    it('rejects invalid options, identifiers, dates and projections before querying', async () => {
      const model = await createRangeModel();
      const invalid = [undefined, null, [], 'created_at', {},
        ...[null, 1, {}, 'created_at; DROP TABLE apps', 'apps.created_at'].map(timestamp => ({ ...range, timestamp })),
        ...[undefined, null, '', 'not-a-date', "2026-02-01' OR '1'='1", 123, {}, new Date(NaN)]
          .map(from => ({ ...range, from })),
        ...[null, '', 'not-a-date', false, new Date(NaN), '2026-01-01'].map(to => ({ ...range, to })),
        ...[null, '', {}, 'email; DROP TABLE apps'].map(withValue => ({ ...range, withValue })),
        ...[null, '', [], '*,email', 'email,,id', 'email; DROP TABLE apps', 'email as secret']
          .map(selectableProps => ({ ...range, selectableProps }))];

      for (const options of invalid) {
        expect(await rejectionOf(model.getInTimeRange(options))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
      expect(await model.getInTimeRange(range)).toEqual(rows);
    });

    it('rethrows database errors and timeouts, logs no values, and remains usable', async () => {
      const model = await createRangeModel();
      for (const error of [Object.assign(new Error('private value'), { code: '42703' }),
        Object.assign(new Error('query timed out'), { name: 'KnexTimeoutError' })]) {
        run.mockRejectedValue(error);
        expect(await rejectionOf(model.getInTimeRange(range))).toBe(error);
        expect(logger.error).toHaveBeenLastCalledWith(
          'DB time range read error', { table: 'apps', code: error.code }
        );
        expect(JSON.stringify(logger.error.mock.lastCall)).not.toContain(error.message);
        run.mockResolvedValue(rows);
        expect(await model.getInTimeRange(range)).toEqual(rows);
      }
    });
  });

  describe('getCount', () => {
    let run;
    let builder;

    const createCountModel = async (options = {}) => {
      const { instance } = stubbedKnex();
      run = jest.fn().mockResolvedValue([{ count: '2' }]);
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('counts matching rows and converts the PostgreSQL count string to a number', async () => {
      const model = await createCountModel({ selectableProps: ['email'] });

      expect(await model.getCount({ email: 'test@example.com' })).toBe(2);
      expect(builder.toSQL().sql).toBe('select count(*) as "count" from "apps" where "email" = ?');
      expect(builder.toSQL().bindings).toEqual(['test@example.com']);
    });

    it('counts all rows when filters are omitted or empty', async () => {
      const model = await createCountModel();

      for (const where of [undefined, {}]) {
        expect(await model.getCount(where)).toBe(2);
        expect(builder.toSQL().sql).toBe('select count(*) as "count" from "apps"');
      }
    });

    it('returns zero when no rows match', async () => {
      const model = await createCountModel();
      run.mockResolvedValue([{ count: '0' }]);

      expect(await model.getCount({ id: 1 })).toBe(0);
    });

    it('combines multiple criteria with AND and handles nulls without mutating filters', async () => {
      const model = await createCountModel();
      const where = Object.freeze({ email: 'test@example.com', deleted_at: null });
      await model.getCount(where);

      expect(builder.toSQL().sql).toBe(
        'select count(*) as "count" from "apps" where "email" = ? and "deleted_at" is null'
      );
      expect(builder.toSQL().bindings).toEqual(['test@example.com']);
      expect(where).toEqual({ email: 'test@example.com', deleted_at: null });
    });

    it('binds malicious values as parameters', async () => {
      const model = await createCountModel();
      const malicious = "x' OR '1'='1";
      await model.getCount({ email: malicious });

      expect(builder.toSQL().sql).not.toContain(malicious);
      expect(builder.toSQL().bindings).toEqual([malicious]);
    });

    it('uses the timeout supplied during initialisation', async () => {
      const model = await createCountModel({ requestTimeout: 1234 });
      await model.getCount();

      expect(builder.toSQL().timeout).toBe(1234);
    });

    it('uses the default timeout when none is supplied', async () => {
      const model = await createCountModel();
      await model.getCount();

      expect(builder.toSQL().timeout).toBe(10000);
    });

    it('logs and rethrows DB errors without logging filter values and remains usable', async () => {
      const model = await createCountModel();
      const failure = Object.assign(new Error('query failed for secret@example.com'), { code: '42703' });
      run.mockRejectedValueOnce(failure);

      expect(await rejectionOf(model.getCount({ email: 'secret@example.com' }))).toBe(failure);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB count error', { table: 'apps', columns: ['email'], code: '42703' }
      );
      expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('secret@example.com');
      expect(await model.getCount()).toBe(2);
    });

    it('propagates timeout errors and allows subsequent queries', async () => {
      const model = await createCountModel();
      const failure = new Error('Defined query timeout of 1234ms exceeded when running query.');
      failure.name = 'KnexTimeoutError';
      run.mockRejectedValueOnce(failure);

      expect(await rejectionOf(model.getCount())).toBe(failure);
      expect(await model.getCount()).toBe(2);
    });

    it('rejects invalid input before executing a query', async () => {
      const model = await createCountModel();
      const invalid = [
        null, 'id = 1', [], 42, true, new Date(),
        { 'id; drop table apps': 1 }, { email: { $ne: '' } },
        { email: undefined }, { id: NaN }, { id: Infinity }, { created_at: new Date('invalid') },
        { email: () => 'unsafe' }
      ];

      for (const where of invalid) {
        expect(await rejectionOf(model.getCount(where))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(await model.getCount()).toBe(2);
    });
  });

  describe('getMetrics', () => {
    const sizes = { table_size: '16 kB', database_name: 'test_db', database_size: '7 MB' };
    let run;
    let builders;

    const createMetricsModel = async (options = {}) => {
      const { instance } = stubbedKnex();
      run = jest.fn(query => Promise.resolve(query._method === 'first' ? sizes : [{ count: '2' }]));
      builders = [];
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builders.push(query);
        return { run: () => run(query) };
      });
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
      // The connection check stubs knex.raw; metrics need the real one to build its function calls.
      rawRestorers.forEach(restore => restore());
      return model;
    };
    const sqlOf = () => builders.map(builder => builder.toSQL());

    it('returns table and database metrics with the row count as a number', async () => {
      const model = await createMetricsModel({ selectableProps: ['email'] });

      expect(await model.getMetrics()).toEqual({
        table_name: 'apps', table_size: '16 kB', database_name: 'test_db', database_size: '7 MB', row_count: 2
      });
    });

    it('builds parameterised queries for the sizes and the count', async () => {
      const model = await createMetricsModel();
      await model.getMetrics({ email: 'test@example.com', deleted_at: null });
      const [metrics, count] = sqlOf();

      expect(metrics.sql).toBe(
        'select pg_size_pretty(pg_total_relation_size("relid")) as "table_size", ' +
        'current_database() as "database_name", ' +
        'pg_size_pretty(pg_database_size(current_database())) as "database_size" ' +
        'from "pg_catalog"."pg_stat_user_tables" where "relname" = ? and "schemaname" = current_schema() limit ?'
      );
      expect(metrics.bindings).toEqual(['apps', 1]);
      expect(count.sql).toBe('select count(*) as "count" from "apps" where "email" = ? and "deleted_at" is null');
      expect(count.bindings).toEqual(['test@example.com']);
    });

    it('counts all rows when filters are omitted or empty', async () => {
      const model = await createMetricsModel();

      for (const where of [undefined, {}]) {
        builders = [];
        await model.getMetrics(where);
        expect(sqlOf()[1].sql).toBe('select count(*) as "count" from "apps"');
      }
    });

    it('binds malicious values as parameters without mutating filters', async () => {
      const model = await createMetricsModel();
      const where = Object.freeze({ email: "x' OR '1'='1" });
      await model.getMetrics(where);

      expect(sqlOf()[1].sql).not.toContain(where.email);
      expect(sqlOf()[1].bindings).toEqual([where.email]);
      expect(where).toEqual({ email: "x' OR '1'='1" });
    });

    it('uses the timeout supplied during initialisation for every query', async () => {
      const model = await createMetricsModel({ requestTimeout: 1234 });
      await model.getMetrics();

      expect(sqlOf().map(({ timeout }) => timeout)).toEqual([1234, 1234]);
    });

    it('uses the default timeout when none is supplied', async () => {
      const model = await createMetricsModel();
      await model.getMetrics();

      expect(sqlOf().map(({ timeout }) => timeout)).toEqual([10000, 10000]);
    });

    it('logs and rethrows DB errors and timeouts without values and remains usable', async () => {
      const model = await createMetricsModel();
      const failures = [
        Object.assign(new Error('query failed for secret@example.com'), { code: '42703' }),
        Object.assign(new Error('Defined query timeout of 10000ms exceeded'), { name: 'KnexTimeoutError' })
      ];

      for (const failure of failures) {
        run.mockRejectedValueOnce(failure);
        expect(await rejectionOf(model.getMetrics({ email: 'secret@example.com' }))).toBe(failure);
        expect(logger.error).toHaveBeenLastCalledWith(
          'DB metrics error', { table: 'apps', columns: ['email'], code: failure.code }
        );
        expect(JSON.stringify(logger.error.mock.lastCall)).not.toContain('secret@example.com');
        expect((await model.getMetrics()).row_count).toBe(2);
      }
    });

    it('rejects when the table has no metrics', async () => {
      const model = await createMetricsModel();
      run.mockImplementation(query => Promise.resolve(query._method === 'first' ? undefined : [{ count: '2' }]));

      const error = await rejectionOf(model.getMetrics());
      expect(error.message).toBe('Metrics for table "apps" not found');
      expectFirstCallStartsWith(logger.error, 'DB metrics error');
    });

    it('rejects invalid input before executing a query', async () => {
      const model = await createMetricsModel();
      const invalid = [
        null, 'id = 1', [], 42, true, new Date(),
        { 'id; drop table apps': 1 }, { email: { $ne: '' } },
        { email: undefined }, { id: NaN }, { created_at: new Date('invalid') }
      ];

      for (const where of invalid) {
        expect(await rejectionOf(model.getMetrics(where))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('patch', () => {
    const rows = [{ id: 1, email: 'new@example.com' }];
    let run;
    let builder;

    const createPatchModel = async (options = {}, { runError } = {}) => {
      const { instance } = stubbedKnex();
      run = runError ? jest.fn().mockRejectedValue(runError) : jest.fn().mockResolvedValue(rows);
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('updates the row by id using bound parameters and returns the selectable props', async () => {
      const model = await createPatchModel({ selectableProps: ['email'] });
      const result = await model.patch(1, { email: 'new@example.com' });
      const { sql, bindings } = builder.toSQL();

      expect(result).toEqual(rows);
      expect(sql).toBe(
        'update "apps" set "email" = ?, "updated_at" = CURRENT_TIMESTAMP where "id" = ? ' +
        'returning "id", "created_at", "updated_at", "email"'
      );
      expect(bindings).toEqual(['new@example.com', 1]);
    });

    it('binds values as parameters rather than inlining them', async () => {
      const model = await createPatchModel();
      const malicious = "x'; DROP TABLE apps; --";
      await model.patch('abc', { email: malicious });
      const { sql, bindings } = builder.toSQL();

      expect(sql).not.toContain(malicious);
      expect(bindings).toEqual([malicious, 'abc']);
    });

    it('uses the request timeout', async () => {
      const model = await createPatchModel({ requestTimeout: 4321 });
      await model.patch(1, { email: 'a@b.com' });

      expect(builder.toSQL().timeout).toBe(4321);
    });

    it('overrides a supplied updated_at and does not mutate the input', async () => {
      const model = await createPatchModel();
      const fields = { email: 'a@b.com', updated_at: 'yesterday' };
      await model.patch(1, fields);

      expect(builder.toSQL().sql).toContain('"updated_at" = CURRENT_TIMESTAMP');
      expect(fields).toEqual({ email: 'a@b.com', updated_at: 'yesterday' });
    });

    it('logs and rethrows query errors without logging values', async () => {
      const runError = Object.assign(new Error('query timed out'), { code: '57014' });
      const model = await createPatchModel({}, { runError });
      const error = await rejectionOf(model.patch(1, { email: 'a@b.com' }));

      expect(error.message).toBe('query timed out');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB update error', { table: 'apps', columns: ['email'], code: '57014' }
      );
    });

    it('continues to work after an error', async () => {
      const model = await createPatchModel();
      run.mockRejectedValueOnce(new Error('boom'));

      await rejectionOf(model.patch(1, { email: 'a@b.com' }));
      expect(await model.patch(1, { email: 'a@b.com' })).toEqual(rows);
    });

    it('rejects invalid input without querying the DB', async () => {
      const model = await createPatchModel();
      const invalid = [
        [1, {}],
        [1, null],
        [1, 'email'],
        [1, { 'email; drop table apps': 'x' }],
        [1, { email: { $ne: '' } }],
        [{ $ne: 1 }, { email: 'a@b.com' }],
        [undefined, { email: 'a@b.com' }],
        [NaN, { email: 'a@b.com' }]
      ];

      for (const [id, fields] of invalid) {
        expect(await rejectionOf(model.patch(id, fields))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const rows = [{ id: 1, email: 'test@example.com' }];
    let instance;
    let run;
    let builder;

    const createModelForInsert = async (options = {}, { runError } = {}) => {
      ({ instance } = stubbedKnex());
      run = runError ? jest.fn().mockRejectedValue(runError) : jest.fn().mockResolvedValue(rows);
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('inserts the data and returns the selectable props', async () => {
      const model = await createModelForInsert({ selectableProps: ['email'] });
      const data = { email: 'test@example.com' };
      const result = await model.create(data);
      const { sql, bindings } = builder.toSQL();

      expect(result).toEqual(rows);
      expect(sql).toBe(
        'insert into "apps" ("email") values (?) returning "id", "created_at", "updated_at", "email"'
      );
      expect(bindings).toEqual(['test@example.com']);
      expect(data).toEqual({ email: 'test@example.com' });
    });

    it('uses the request timeout', async () => {
      const model = await createModelForInsert({ requestTimeout: 1234 });
      await model.create({ email: 'test@example.com' });

      expect(builder.toSQL().timeout).toBe(1234);
    });

    it('logs and rethrows query errors without logging inserted values', async () => {
      const runError = Object.assign(new Error('insert failed'), { code: '23505' });
      const model = await createModelForInsert({}, { runError });
      const error = await rejectionOf(model.create({ email: 'sensitive@example.com' }));

      expect(error.message).toBe('insert failed');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB create error', { table: 'apps', columns: ['email'], code: '23505' }
      );
      expect(logger.error.mock.calls[0][1]).not.toHaveProperty('email');
    });

    it('rejects invalid or empty data without querying the DB', async () => {
      const model = await createModelForInsert();

      for (const data of [{}, null, 'email', { 'email; drop table apps': 'x' }, { email: { $ne: '' } }]) {
        expect(await rejectionOf(model.create(data))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    let instance;
    let run;
    let builder;

    const createModelForDelete = async (options = {}, { runError } = {}) => {
      ({ instance } = stubbedKnex());
      run = runError ? jest.fn().mockRejectedValue(runError) : jest.fn().mockResolvedValue(1);
      jest.spyOn(instance.client, 'runner').mockImplementation(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('deletes the row with the given id and returns the deleted count', async () => {
      const model = await createModelForDelete();
      const result = await model.delete(1);
      const { sql, bindings } = builder.toSQL();

      expect(result).toBe(1);
      expect(sql).toBe('delete from "apps" where "id" = ?');
      expect(bindings).toEqual([1]);
    });

    it('accepts string ids and binds them as parameters', async () => {
      const model = await createModelForDelete();
      const malicious = "1' OR '1'='1";
      await model.delete(malicious);
      const { sql, bindings } = builder.toSQL();

      expect(sql).toBe('delete from "apps" where "id" = ?');
      expect(bindings).toEqual([malicious]);
    });

    it('returns 0 when no row matches', async () => {
      const model = await createModelForDelete();
      run.mockResolvedValue(0);

      expect(await model.delete(999)).toBe(0);
    });

    it('uses the request timeout', async () => {
      const model = await createModelForDelete({ requestTimeout: 1234 });
      await model.delete(1);

      expect(builder.toSQL().timeout).toBe(1234);
    });

    it('logs and rethrows query errors with the error code only', async () => {
      // 57014 is PostgreSQL's query_canceled code, which is what a statement timeout raises.
      const runError = Object.assign(new Error('query timed out'), { code: '57014' });
      const model = await createModelForDelete({}, { runError });
      const error = await rejectionOf(model.delete(1));

      expect(error).toBe(runError);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenNthCalledWith(1,
        'DB delete error', { table: 'apps', code: '57014' }
      );
    });

    it('continues to work after an error', async () => {
      const model = await createModelForDelete();
      run.mockRejectedValueOnce(new Error('boom'));

      await rejectionOf(model.delete(1));
      expect(await model.delete(1)).toBe(1);
    });

    it('rejects invalid ids without querying the DB', async () => {
      const model = await createModelForDelete();

      for (const id of [undefined, null, 0, -1, 1.5, NaN, Infinity, '', '  ', {}, [], { id: 1 }, true]) {
        expect(await rejectionOf(model.delete(id))).toBeInstanceOf(TypeError);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('requires a knex connection, knex config and table name', async () => {
      const instance = knex(knexConfig);
      instances.push(instance);

      expect(await rejectionOf(createModel({ knexConfig, tableName: 'apps' }))).toBeInstanceOf(TypeError);
      expect(await rejectionOf(createModel({ knex: instance, tableName: 'apps' }))).toBeInstanceOf(TypeError);
      expect(await rejectionOf(createModel({ knex: instance, knexConfig }))).toBeInstanceOf(TypeError);
    });
  });
});
