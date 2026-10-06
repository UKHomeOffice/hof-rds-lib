import { expect } from 'chai';
import sinon from 'sinon';
import knex from 'knex';
import createModel from '../../lib/model.js';
import loggerFactory from '../../lib/logger.js';

const dbConfig = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  }
};

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
    const tableName = `hof_rds_lib_test_${process.pid}`;
    let setup;

    before(async function () {
      if (!process.env.DB_NAME) {
        this.skip();
      }
      setup = knex(dbConfig);
      await setup.schema.createTable(tableName, table => {
        table.increments('id');
        table.timestamps(true, true);
      });
    });

    after(async () => {
      if (setup) {
        await setup.schema.dropTableIfExists(tableName);
        await setup.destroy();
      }
    });

    it('connects to the DB and table', async () => {
      const model = await createModel({ knex, knexConfig: dbConfig, tableName, logger });
      instances.push(model.knex);

      expect(model.tableName).to.equal(tableName);
      expect(logger.info).to.have.been.calledTwice;
      expect(logger.info.secondCall.args[0]).to.equal('DB connection successful');
      expect(logger.info.secondCall.args[1]).to.include({ database: process.env.DB_NAME, table: tableName });
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
