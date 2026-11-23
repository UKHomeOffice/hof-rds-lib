import { expect, jest } from '@jest/globals';
import knex from 'knex';
import { createServer } from 'node:net';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  RDSClient
} from '@aws-sdk/client-rds';
import { GenericContainer, Wait } from 'testcontainers';
import createModel from '../../lib/model.js';
import loggerFactory from '../../lib/logger.js';

describe('createModel with a real knex connection', () => {
  const expectFirstCallStartsWith = (mock, ...args) => {
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0].slice(0, args.length)).toEqual(args);
  };
  let instances;
  let logger;

  const rejectionOf = promise => promise.then(() => expect.fail('expected promise to reject'), error => error);

  beforeEach(() => {
    instances = [];
    logger = loggerFactory();
    jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'error');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(instances.map(instance => instance.destroy()));
  });

  it('logs an error when the DB cannot be reached (expected ECONNREFUSED warning)', async () => {
    // A non-test env so the warning is printed; kept separate from the spied model logger.
    const expectedWarnings = loggerFactory({ env: 'local', label: 'expected test warning' });
    const knexConfig = {
      client: 'pg',
      connection: { host: '127.0.0.1', port: 1, database: 'unreachable' },
      // knex warns about the deliberately failed connection; label it so it isn't mistaken for a failure.
      log: {
        warn: message => expectedWarnings.warn(String(message).split('\n')[0])
      }
    };

    const error = await rejectionOf(
      createModel({ knex, knexConfig, tableName: 'apps', requestTimeout: 2000, logger })
    );

    expect(error.name).toBe('Error');
    expect(error.message).toMatch(/ECONNREFUSED/);
    expectFirstCallStartsWith(logger.info, 'Attempting DB connection');
    expectFirstCallStartsWith(logger.error, 'DB connection error');
    expect(logger.error.mock.calls[0][1]).toMatchObject({ database: 'unreachable', table: 'apps' });
    expect(logger.error.mock.calls[0][1].error).toMatch(/ECONNREFUSED/);
  });

  describe('against a database', function () {
    let ministack;
    let rds;
    let dbConfig;
    const tableName = 'hof_rds_lib_test';
    const dbInstanceIdentifier = `hof-rds-lib-instance-${process.pid}-${Date.now()}`;
    const dbName = 'hof_rds_lib_test';
    let dbInstanceCreated = false;
    let setup;

    // Reserve a Docker-host port for MiniStack's nested PostgreSQL container.
    const reserveHostPort = async () => {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', resolve);
      });

      const address = server.address();
      if (!address || typeof address === 'string') {
        await new Promise(resolve => server.close(resolve));
        throw new Error('Could not reserve a Docker-host port for MiniStack RDS');
      }

      return {
        port: address.port,
        release: () => new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        })
      };
    };

    // Poll the RDS API until the instance reports that provisioning is complete.
    const waitForDatabaseInstance = async () => {
      const deadline = Date.now() + 90000;

      while (Date.now() < deadline) {
        const response = await rds.send(new DescribeDBInstancesCommand({
          DBInstanceIdentifier: dbInstanceIdentifier
        }));
        const instance = response.DBInstances?.[0];

        if (instance?.DBInstanceStatus === 'available') {
          return instance;
        }
        if (instance?.DBInstanceStatus === 'failed') {
          throw new Error(`MiniStack RDS instance failed: ${dbInstanceIdentifier}`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      throw new Error(`Timed out waiting for MiniStack RDS instance: ${dbInstanceIdentifier}`);
    };

    // Verify SQL connectivity after the RDS API reports the instance as available.
    const waitForPostgresConnection = async () => {
      const deadline = Date.now() + 30000;
      let lastError;

      while (Date.now() < deadline) {
        try {
          await setup.raw('select 1');
          return;
        } catch (error) {
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      throw new Error(
        `PostgreSQL endpoint ${dbConfig.connection.host}:${dbConfig.connection.port} ` +
        `did not become ready: ${lastError?.message || 'connection failed'}`,
        { cause: lastError }
      );
    };

    beforeAll(async () => {
      const rdsPortReservation = await reserveHostPort();
      try {
        ministack = await new GenericContainer('ministackorg/ministack:1.5.30')
          .withExposedPorts(4566)
          .withBindMounts([{
            source: '/var/run/docker.sock',
            target: '/var/run/docker.sock'
          }])
          .withEnvironment({
            MINISTACK_HOST: 'localhost',
            MINISTACK_RDS_PUBLIC_ENDPOINT: '1',
            RDS_BASE_PORT: String(rdsPortReservation.port)
          })
          .withWaitStrategy(Wait.forHttp('/_ministack/health', 4566))
          .withStartupTimeout(120000)
          .start();
      } finally {
        await rdsPortReservation.release();
      }
      const miniStackEndpoint = `http://${ministack.getHost()}:${ministack.getMappedPort(4566)}`;
      rds = new RDSClient({
        endpoint: miniStackEndpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
      });

      await rds.send(new CreateDBInstanceCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        DBInstanceClass: 'db.t3.micro',
        Engine: 'postgres',
        MasterUsername: 'hof_user',
        MasterUserPassword: 'hof-rds-lib-test-password',
        DBName: dbName,
        AllocatedStorage: 20,
        PubliclyAccessible: true
      }));
      dbInstanceCreated = true;

      const instance = await waitForDatabaseInstance();
      const endpoint = instance.Endpoint;
      if (!endpoint?.Address || !endpoint.Port) {
        throw new Error('MiniStack did not return a PostgreSQL endpoint');
      }

      dbConfig = {
        client: 'pg',
        connection: {
          host: endpoint.Address,
          port: endpoint.Port,
          user: 'hof_user',
          password: 'hof-rds-lib-test-password',
          database: dbName,
          connectionTimeoutMillis: 5000
        }
      };
      setup = knex(dbConfig);
      await waitForPostgresConnection();
      await setup.schema.createTable(tableName, table => {
        table.increments('id');
        table.timestamps(true, true);
        table.string('email');
      });
    }, 120000);

    afterAll(async () => {
      try {
        await setup?.destroy();
      } finally {
        try {
          if (dbInstanceCreated && rds) {
            await rds.send(new DeleteDBInstanceCommand({
              DBInstanceIdentifier: dbInstanceIdentifier,
              SkipFinalSnapshot: true
            }));
          }
        } finally {
          rds?.destroy();
          await ministack?.stop();
        }
      }
    }, 60000);

    it('connects to the DB and table', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(model.tableName).toBe(tableName);
      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.info.mock.calls[1][0]).toBe('DB connection successful');
      expect(logger.info.mock.calls[1][1]).toMatchObject({ database: dbConfig.connection.database, table: tableName });
    });

    it('creates a row and retrieves it with the supplied filter', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const email = 'test@example.com';
      const [created] = await model.create({ email });
      const rows = await model.get({ email });

      expect(created).toMatchObject({ email });
      expect(created.id).toEqual(expect.any(Number));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(created);
    });

    it('retrieves null values and returns no rows for an unmatched filter', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const [created] = await model.create({ email: null });

      expect(await model.get({ email: null })).toEqual([created]);
      expect(await model.get({ email: 'missing@example.com' })).toEqual([]);
    });

    describe('getInTimeRange', () => {
      let model;
      const range = {
        timestamp: 'created_at', from: '2001-02-01T00:00:00.000Z', to: '2001-02-05T00:00:00.000Z'
      };

      beforeEach(async () => {
        model = await createModel({
          knex, knexConfig: dbConfig, tableName, requestTimeout: 2000, selectableProps: ['email'], logger
        });
        instances.push(model.knex);
      });

      it('includes both boundaries and excludes rows outside the range', async () => {
        const dates = ['2001-01-31T23:59:59.999Z', range.from, '2001-02-03T00:00:00.000Z',
          range.to, '2001-02-05T00:00:00.001Z'];
        const created = await Promise.all(dates.map(createdAt => model.create({
          email: 'range-boundary@example.com', created_at: createdAt
        })));
        try {
          const rows = await model.getInTimeRange(range);
          expect(rows.map(row => row.id).sort()).toEqual(created.slice(1, 4).map(([row]) => row.id).sort());
          expect(Object.keys(rows[0]).sort()).toEqual(['created_at', 'email', 'id', 'updated_at']);
          expect(await model.getInTimeRange({ ...range, from: range.to })).toEqual(created[3]);
          expect(await model.getInTimeRange({ ...range, from: '2001-02-04', to: '2001-02-04' }))
            .toEqual([]);
        } finally {
          await Promise.all(created.map(([row]) => model.delete(row.id)));
        }
      });

      it('filters non-null values and supports per-call projections without persisting them', async () => {
        const [present] = await model.create({ email: 'range-present@example.com', created_at: range.from });
        const [absent] = await model.create({ email: null, created_at: range.from });
        try {
          const rows = await model.getInTimeRange({ ...range, withValue: 'email', selectableProps: 'email' });
          expect(rows).toEqual([present]);
          const defaults = await createModel({ knex: model.knex, knexConfig: dbConfig, tableName, logger });
          expect((await defaults.getInTimeRange({ ...range, selectableProps: '*' }))[0]).toHaveProperty('email');
          expect((await defaults.getInTimeRange(range))[0]).not.toHaveProperty('email');
        } finally {
          await model.delete(present.id);
          await model.delete(absent.id);
        }
      });

      it('defaults to database time, accepts Date bounds and excludes future rows', async () => {
        const from = new Date('2002-01-01T00:00:00.000Z');
        const [past] = await model.create({ email: 'range-past@example.com', created_at: from });
        const [future] = await model.create({
          email: 'range-future@example.com', created_at: '9999-01-01T00:00:00.000Z'
        });
        try {
          const rows = await model.getInTimeRange({ timestamp: 'created_at', from });
          expect(rows.map(row => row.id)).toContain(past.id);
          expect(rows.map(row => row.id)).not.toContain(future.id);
        } finally {
          await model.delete(past.id);
          await model.delete(future.id);
        }
      });

      it('rejects injection attempts and invalid input, then permits subsequent reads', async () => {
        const invalid = [null, [], {},
          { ...range, timestamp: 'created_at; DROP TABLE hof_rds_lib_test' },
          { ...range, from: "2001-02-01'; DROP TABLE hof_rds_lib_test; --" },
          { ...range, to: 'invalid' }, { ...range, to: '2000-01-01' },
          { ...range, withValue: 'email) OR TRUE --' },
          { ...range, selectableProps: 'email, pg_sleep(10)' }];

        for (const options of invalid) {
          expect(await rejectionOf(model.getInTimeRange(options))).toBeInstanceOf(TypeError);
        }
        expect(logger.error).not.toHaveBeenCalled();
        expect(await model.getInTimeRange(range)).toEqual([]);
      });

      it('returns DB errors to the caller, logs only metadata and remains usable', async () => {
        for (const options of [{ ...range, timestamp: 'missing_range_column' },
          { ...range, withValue: 'missing_range_column' }, { ...range, selectableProps: 'missing_range_column' }]) {
          const error = await rejectionOf(model.getInTimeRange(options));

          expect(error.code).toBe('42703');
          expect(error.message).toContain('missing_range_column');
          expect(logger.error).toHaveBeenLastCalledWith(
            'DB time range read error', { table: tableName, code: '42703' }
          );
          expect(await model.getInTimeRange(range)).toEqual([]);
        }
      });

      it('uses the initialised timeout for a blocked read and recovers afterwards', async () => {
        const shortTimeoutModel = await createModel({
          knex, knexConfig: dbConfig, tableName, requestTimeout: 200, logger
        });
        instances.push(shortTimeoutModel.knex);
        const transaction = await setup.transaction();

        try {
          await transaction.schema.alterTable(tableName, table => table.boolean('range_lock'));
          const error = await rejectionOf(shortTimeoutModel.getInTimeRange(range));

          expect(error.name).toBe('KnexTimeoutError');
          expect(error.message).toContain('200ms');
          expect(logger.error).toHaveBeenCalledTimes(1);
          expect(logger.error.mock.calls[0][0]).toBe('DB time range read error');
        } finally {
          await transaction.rollback();
        }

        expect(await shortTimeoutModel.getInTimeRange(range)).toEqual([]);
      });
    });

    describe('getCount', () => {
      let model;

      beforeEach(async () => {
        model = await createModel({ knex, knexConfig: dbConfig, tableName, requestTimeout: 2000, logger });
        instances.push(model.knex);
      });

      it('counts all rows and reflects inserts and deletes', async () => {
        const initialCount = (await model.get()).length;
        expect(await model.getCount()).toBe(initialCount);

        const [created] = await model.create({ email: 'count-total@example.com' });
        expect(await model.getCount({})).toBe(initialCount + 1);

        await model.delete(created.id);
        expect(await model.getCount()).toBe(initialCount);
      });

      it('counts matching rows, combines filters and returns zero for no matches', async () => {
        const email = 'count-filter@example.com';
        const [created] = await model.create({ email });
        await model.create({ email });

        expect(await model.getCount({ email })).toBe(2);
        expect(await model.getCount({ email, id: created.id })).toBe(1);
        expect(await model.getCount({ email: 'count-missing@example.com' })).toBe(0);
      });

      it('counts null values using IS NULL', async () => {
        const [created] = await model.create({ email: null });

        expect(await model.getCount({ id: created.id, email: null })).toBe(1);
      });

      it('treats injection-like values as data and rejects invalid input', async () => {
        const email = "count'; DROP TABLE hof_rds_lib_test; --";
        await model.create({ email });

        expect(await model.getCount({ email })).toBe(1);
        expect(await model.getCount({ email: "' OR '1'='1" })).toBe(0);
        for (const where of [null, [], 'id = 1', { 'email; DROP TABLE apps': 'x' }, { email: {} }]) {
          expect(await rejectionOf(model.getCount(where))).toBeInstanceOf(TypeError);
        }
        expect(logger.error).not.toHaveBeenCalled();
        expect(await model.getCount({ email })).toBe(1);
      });

      it('returns DB errors to the caller without logging values and remains usable', async () => {
        const error = await rejectionOf(model.getCount({ missing_count_column: 'private-value' }));

        expect(error.code).toBe('42703');
        expect(error.message).toContain('missing_count_column');
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenNthCalledWith(1,
          'DB count error', { table: tableName, columns: ['missing_count_column'], code: '42703' }
        );
        expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('private-value');
        expect(await model.getCount({ id: 2147483647 })).toBe(0);
      });

      it('uses the initialised timeout for a blocked count and recovers afterwards', async () => {
        const shortTimeoutModel = await createModel({
          knex, knexConfig: dbConfig, tableName, requestTimeout: 200, logger
        });
        instances.push(shortTimeoutModel.knex);
        const transaction = await setup.transaction();

        try {
          await transaction.schema.alterTable(tableName, table => table.boolean('count_lock'));
          const error = await rejectionOf(shortTimeoutModel.getCount());

          expect(error.name).toBe('KnexTimeoutError');
          expect(error.message).toContain('200ms');
          expectFirstCallStartsWith(logger.error, 'DB count error');
        } finally {
          await transaction.rollback();
        }

        expect(await shortTimeoutModel.getCount({ id: 2147483647 })).toBe(0);
      });
    });

    it('patches only the row with the given id and refreshes updated_at', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const [toPatch] = await model.create({ email: 'before@example.com' });
      const [toKeep] = await model.create({ email: 'untouched@example.com' });
      const [patched] = await model.patch(toPatch.id, { email: 'after@example.com' });

      expect(patched).toMatchObject({ id: toPatch.id, email: 'after@example.com' });
      expect(new Date(patched.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(toPatch.updated_at).getTime());
      expect(await model.get({ id: toPatch.id })).toEqual([patched]);
      expect(await model.get({ id: toKeep.id })).toEqual([toKeep]);
    });

    it('returns an empty array when patching an id that does not exist', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(await model.patch(2147483647, { email: 'nobody@example.com' })).toEqual([]);
    });

    it('rejects invalid patch input without logging a DB error', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(await rejectionOf(model.patch(1, {}))).toBeInstanceOf(TypeError);
      expect(await rejectionOf(model.patch(1, { 'email; drop table x': 'a' }))).toBeInstanceOf(TypeError);
      expect(await rejectionOf(model.patch({ $ne: 1 }, { email: 'a@b.com' }))).toBeInstanceOf(TypeError);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs and rethrows DB errors on patch without logging values and remains usable', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      // A non-numeric string passes input validation but is rejected by the integer id column.
      const error = await rejectionOf(model.patch('not-a-number', { email: 'secret@example.com' }));

      expect(error.message).toMatch(/invalid input syntax for type integer/);
      expectFirstCallStartsWith(logger.error, 'DB update error');
      expect(logger.error.mock.calls[0][1]).toMatchObject({ table: tableName });
      expect(logger.error.mock.calls[0][1].columns).toEqual(['email']);
      expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('secret@example.com');

      const [created] = await model.create({ email: 'after-patch-error@example.com' });
      const [patched] = await model.patch(created.id, { email: 'recovered@example.com' });
      expect(patched.email).toBe('recovered@example.com');
    });

    it('deletes only the row with the given id', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const [toDelete] = await model.create({ email: 'delete-me@example.com' });
      const [toKeep] = await model.create({ email: 'keep-me@example.com' });

      expect(await model.delete(toDelete.id)).toBe(1);
      expect(await model.get({ id: toDelete.id })).toEqual([]);
      expect(await model.get({ id: toKeep.id })).toEqual([toKeep]);
    });

    it('returns 0 when deleting an id that does not exist', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(await model.delete(2147483647)).toBe(0);
    });

    it('logs and rethrows DB errors on delete and remains usable', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      // A non-numeric string passes input validation but is rejected by the integer id column.
      const error = await rejectionOf(model.delete('not-a-number'));

      expect(error.message).toMatch(/invalid input syntax for type integer/);
      expectFirstCallStartsWith(logger.error, 'DB delete error');
      // 22P02 is PostgreSQL's invalid_text_representation; error.message quotes the id, so only the code is logged.
      expect(logger.error.mock.calls[0][1]).toEqual({ table: tableName, code: '22P02' });
      expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('not-a-number');

      const [created] = await model.create({ email: 'after-error@example.com' });
      expect(await model.delete(created.id)).toBe(1);
    });

    it('logs a failure when the table does not exist', async () => {
      const instance = knex(dbConfig);
      instances.push(instance);

      const error = await rejectionOf(createModel({
        knex: instance, knexConfig: dbConfig, tableName: 'hof_rds_lib_missing_table', logger
      }));

      expect(error.message).toMatch(/does not exist/);
      expectFirstCallStartsWith(logger.warn, 'DB connection failed');
    });
  });
});
