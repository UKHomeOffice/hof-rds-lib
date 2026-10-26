import { expect } from 'chai';
import sinon from 'sinon';
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
  let instances;
  let logger;

  const rejectionOf = promise => promise.then(() => expect.fail('expected promise to reject'), error => error);

  beforeEach(() => {
    instances = [];
    logger = loggerFactory();
    sinon.spy(logger, 'info');
    sinon.spy(logger, 'warn');
    sinon.spy(logger, 'error');
  });

  afterEach(async () => {
    sinon.restore();
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

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.match(/ECONNREFUSED/);
    expect(logger.info).to.have.been.calledOnceWith('Attempting DB connection');
    expect(logger.error).to.have.been.calledOnceWith('DB connection error');
    expect(logger.error.firstCall.args[1]).to.include({ database: 'unreachable', table: 'apps' });
    expect(logger.error.firstCall.args[1].error).to.match(/ECONNREFUSED/);
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

    before(async function () {
      this.timeout(120000);
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
    });

    after(async function () {
      this.timeout(60000);
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
    });

    it('connects to the DB and table', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(model.tableName).to.equal(tableName);
      expect(logger.info).to.have.been.calledTwice;
      expect(logger.info.secondCall.args[0]).to.equal('DB connection successful');
      expect(logger.info.secondCall.args[1]).to.include({ database: dbConfig.connection.database, table: tableName });
    });

    it('creates a row and retrieves it with the supplied filter', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const email = 'test@example.com';
      const [created] = await model.create({ email });
      const rows = await model.get({ email });

      expect(created).to.include({ email });
      expect(created.id).to.be.a('number');
      expect(rows).to.have.lengthOf(1);
      expect(rows[0]).to.deep.equal(created);
    });

    it('retrieves null values and returns no rows for an unmatched filter', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const [created] = await model.create({ email: null });

      expect(await model.get({ email: null })).to.deep.equal([created]);
      expect(await model.get({ email: 'missing@example.com' })).to.deep.equal([]);
    });

    it('deletes only the row with the given id', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      const [toDelete] = await model.create({ email: 'delete-me@example.com' });
      const [toKeep] = await model.create({ email: 'keep-me@example.com' });

      expect(await model.delete(toDelete.id)).to.equal(1);
      expect(await model.get({ id: toDelete.id })).to.deep.equal([]);
      expect(await model.get({ id: toKeep.id })).to.deep.equal([toKeep]);
    });

    it('returns 0 when deleting an id that does not exist', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(await model.delete(2147483647)).to.equal(0);
    });

    it('logs and rethrows DB errors on delete and remains usable', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, selectableProps: ['email'], logger });
      instances.push(model.knex);

      // A non-numeric string passes input validation but is rejected by the integer id column.
      const error = await rejectionOf(model.delete('not-a-number'));

      expect(error.message).to.match(/invalid input syntax for type integer/);
      expect(logger.error).to.have.been.calledOnceWith('DB delete error');
      // 22P02 is PostgreSQL's invalid_text_representation; error.message quotes the id, so only the code is logged.
      expect(logger.error.firstCall.args[1]).to.deep.equal({ table: tableName, code: '22P02' });
      expect(JSON.stringify(logger.error.firstCall.args)).to.not.include('not-a-number');

      const [created] = await model.create({ email: 'after-error@example.com' });
      expect(await model.delete(created.id)).to.equal(1);
    });

    it('logs a failure when the table does not exist', async () => {
      const instance = knex(dbConfig);
      instances.push(instance);

      const error = await rejectionOf(createModel({
        knex: instance, knexConfig: dbConfig, tableName: 'hof_rds_lib_missing_table', logger
      }));

      expect(error.message).to.match(/does not exist/);
      expect(logger.warn).to.have.been.calledOnceWith('DB connection failed');
    });
  });
});
