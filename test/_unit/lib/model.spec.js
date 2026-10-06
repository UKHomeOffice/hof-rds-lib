import { expect } from 'chai';
import sinon from 'sinon';
import knex from 'knex';
import createModel, { DEFAULT_SELECTABLE_PROPS, defineSelectableProps } from '../../../lib/model.js';
import loggerFactory from '../../../lib/logger.js';

const knexConfig = {
  client: 'pg',
  connection: { host: 'localhost', port: 5432, database: 'test_db', user: 'user', password: 'secret' }
};
const loggedDetails = { client: 'pg', table: 'apps', host: 'localhost', port: 5432, database: 'test_db' };

describe('createModel', () => {
  let instances;
  let logger;

  // Real knex instance (no connection is made until a query runs) with only the DB round-trips stubbed.
  const stubbedKnex = ({ config = knexConfig, rawError, hasTable = true, hasTableError } = {}) => {
    const instance = knex(config);
    instances.push(instance);

    const timeout = rawError ? sinon.stub().rejects(rawError) : sinon.stub().resolves();
    const raw = sinon.stub(instance, 'raw').returns({ timeout });
    const hasTableStub = hasTableError ? sinon.stub().rejects(hasTableError) : sinon.stub().resolves(hasTable);
    sinon.stub(instance.client, 'schemaBuilder').returns({ hasTable: hasTableStub });

    return { instance, raw, timeout, hasTable: hasTableStub };
  };

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

  describe('on a successful connection', () => {
    it('returns a model with defaults', async () => {
      const { instance } = stubbedKnex();
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps', logger });

      expect(model.knex).to.equal(instance);
      expect(model.tableName).to.equal('apps');
      expect(model.requestTimeout).to.equal(10000);
      expect(model.selectableProps).to.deep.equal(DEFAULT_SELECTABLE_PROPS);
      expect(model.logger).to.equal(logger);
    });

    it('verifies the connection and table using the request timeout', async () => {
      const { instance, raw, timeout, hasTable } = stubbedKnex();
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps', requestTimeout: 2500, logger });

      expect(raw).to.have.been.calledOnceWithExactly('select 1');
      expect(timeout).to.have.been.calledOnceWithExactly(2500);
      expect(hasTable).to.have.been.calledOnceWithExactly('apps');
      expect(model.requestTimeout).to.equal(2500);
    });

    it('applies custom selectable props on top of the defaults', async () => {
      const { instance } = stubbedKnex();
      const model = await createModel({
        knex: instance, knexConfig, tableName: 'apps', selectableProps: ['email', 'session'], logger
      });

      expect(model.selectableProps).to.deep.equal([...DEFAULT_SELECTABLE_PROPS, 'email', 'session']);
    });

    it('logs the attempt and success with connection details but no credentials', async () => {
      const { instance } = stubbedKnex();
      await createModel({ knex: instance, knexConfig, tableName: 'apps', logger });

      expect(logger.info).to.have.been.calledTwice;
      expect(logger.info.firstCall).to.have.been.calledWithExactly('Attempting DB connection', loggedDetails);
      expect(logger.info.secondCall).to.have.been.calledWithExactly('DB connection successful', loggedDetails);
      expect(logger.warn).to.not.have.been.called;
      expect(logger.error).to.not.have.been.called;
    });

    it('does not log a connection string', async () => {
      const config = { client: 'pg', connection: 'postgres://user:secret@localhost/test_db' };
      const { instance } = stubbedKnex({ config });
      await createModel({ knex: instance, knexConfig: config, tableName: 'apps', logger });

      for (const call of logger.info.getCalls()) {
        expect(call.args[1]).to.deep.equal({ client: 'pg', table: 'apps' });
      }
    });

    it('uses the library logger by default', async () => {
      const { instance } = stubbedKnex();
      const model = await createModel({ knex: instance, knexConfig, tableName: 'apps' });

      expect(model.logger.logSession).to.be.a('function');
    });
  });

  describe('on a failed connection', () => {
    it('logs and rethrows connection errors', async () => {
      const { instance } = stubbedKnex({ rawError: new Error('ECONNREFUSED') });
      const error = await rejectionOf(createModel({ knex: instance, knexConfig, tableName: 'apps', logger }));

      expect(error.message).to.equal('ECONNREFUSED');
      expect(logger.error).to.have.been.calledOnceWithExactly(
        'DB connection error', { ...loggedDetails, error: 'ECONNREFUSED' }
      );
      expect(logger.error).to.have.been.calledAfter(logger.info);
    });

    it('logs and rethrows errors from the table check', async () => {
      const { instance } = stubbedKnex({ hasTableError: new Error('permission denied') });
      const error = await rejectionOf(createModel({ knex: instance, knexConfig, tableName: 'apps', logger }));

      expect(error.message).to.equal('permission denied');
      expect(logger.error).to.have.been.calledOnceWithExactly(
        'DB connection error', { ...loggedDetails, error: 'permission denied' }
      );
    });

    it('logs a failure when the table does not exist', async () => {
      const { instance } = stubbedKnex({ hasTable: false });
      const error = await rejectionOf(createModel({ knex: instance, knexConfig, tableName: 'apps', logger }));

      expect(error.message).to.equal('Table "apps" does not exist');
      expect(logger.warn).to.have.been.calledOnceWithExactly(
        'DB connection failed', { ...loggedDetails, error: 'Table "apps" does not exist' }
      );
      expect(logger.error).to.not.have.been.called;
    });

    it('logs and rethrows errors from creating the knex instance', async () => {
      const badConfig = { client: 'not-a-real-client', connection: {} };
      const error = await rejectionOf(createModel({ knex, knexConfig: badConfig, tableName: 'apps', logger }));

      expect(error.message).to.match(/Unknown configuration option 'client'/);
      expect(logger.info).to.have.been.calledOnceWith('Attempting DB connection');
      expect(logger.error).to.have.been.calledOnceWith('DB connection error');
    });
  });

  describe('validation', () => {
    it('requires a knex connection, knex config and table name', async () => {
      const instance = knex(knexConfig);
      instances.push(instance);

      expect(await rejectionOf(createModel({ knexConfig, tableName: 'apps' }))).to.be.instanceOf(TypeError);
      expect(await rejectionOf(createModel({ knex: instance, tableName: 'apps' }))).to.be.instanceOf(TypeError);
      expect(await rejectionOf(createModel({ knex: instance, knexConfig }))).to.be.instanceOf(TypeError);
    });
  });
});

describe('defineSelectableProps', () => {
  it('appends props to the defaults without duplicates', () => {
    expect(defineSelectableProps(['email'])).to.deep.equal([...DEFAULT_SELECTABLE_PROPS, 'email']);
    expect(defineSelectableProps(['id', 'email'])).to.deep.equal([...DEFAULT_SELECTABLE_PROPS, 'email']);
  });

  it('returns the defaults when no props are given', () => {
    expect(defineSelectableProps()).to.deep.equal(DEFAULT_SELECTABLE_PROPS);
    expect(defineSelectableProps([])).to.deep.equal(DEFAULT_SELECTABLE_PROPS);
  });

  it('returns * on its own', () => {
    expect(defineSelectableProps(['*'])).to.deep.equal(['*']);
  });

  it('does not mutate the defaults', () => {
    defineSelectableProps().push('email');
    expect(DEFAULT_SELECTABLE_PROPS).to.deep.equal(['id', 'created_at', 'updated_at']);
  });
});
