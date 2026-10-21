import { expect } from 'chai';
import sinon from 'sinon';
import knex from 'knex';
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

  it('logs an error when the DB cannot be reached', async () => {
    const knexConfig = { client: 'pg', connection: { host: '127.0.0.1', port: 1, database: 'unreachable' } };

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
    const dbInstanceIdentifier = 'hof-rds-lib-instance';
    const dbName = 'hof_rds_lib_test';
    let dbInstanceCreated = false;
    let setup;

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

    before(async function () {
      this.timeout(120000);
      ministack = await new GenericContainer('ministackorg/ministack:1.5.30')
        .withExposedPorts(4566)
        .withBindMounts([{
          source: '/var/run/docker.sock',
          target: '/var/run/docker.sock'
        }])
        .withEnvironment({
          MINISTACK_HOST: 'localhost',
          MINISTACK_RDS_PUBLIC_ENDPOINT: '1',
          RDS_BASE_PORT: '15432'
        })
        .withWaitStrategy(Wait.forHttp('/_ministack/health', 4566))
        .withStartupTimeout(120000)
        .start();
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
          database: dbName
        }
      };
      setup = knex(dbConfig);
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
