import { expect } from 'chai';
import sinon from 'sinon';
import knex from 'knex';
import createModel, {
  DEFAULT_SELECTABLE_PROPS,
  defineSelectableProps,
  validateColumnValues
} from '../../../lib/model.js';
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

  describe('get', () => {
    const rows = [{ id: 1, email: 'test@example.com' }];
    let instance;
    let run;
    let builder;

    // Captures the built query and stubs only its execution.
    const createGetModel = async (options = {}, { runError } = {}) => {
      ({ instance } = stubbedKnex());
      run = runError ? sinon.stub().rejects(runError) : sinon.stub().resolves(rows);
      sinon.stub(instance.client, 'runner').callsFake(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('selects the selectable props from the table matching the where object', async () => {
      const model = await createGetModel({ selectableProps: ['email'] });
      const result = await model.get({ email: 'test@example.com' });
      const { sql, bindings } = builder.toSQL();

      expect(result).to.deep.equal(rows);
      expect(sql).to.equal('select "id", "created_at", "updated_at", "email" from "apps" where "email" = ?');
      expect(bindings).to.deep.equal(['test@example.com']);
    });

    it('combines multiple criteria and handles nulls', async () => {
      const model = await createGetModel();
      await model.get({ email: 'test@example.com', id: 1, deleted_at: null });
      const { sql, bindings } = builder.toSQL();

      expect(sql).to.equal(
        'select "id", "created_at", "updated_at" from "apps" where "email" = ? and "id" = ? and "deleted_at" is null'
      );
      expect(bindings).to.deep.equal(['test@example.com', 1]);
    });

    it('returns all rows when no criteria are given', async () => {
      const model = await createGetModel();
      await model.get();

      expect(builder.toSQL().sql).to.equal('select "id", "created_at", "updated_at" from "apps"');
    });

    it('binds values as parameters rather than inlining them', async () => {
      const model = await createGetModel();
      const malicious = "x' OR '1'='1";
      await model.get({ email: malicious });
      const { sql, bindings } = builder.toSQL();

      expect(sql).to.not.include(malicious);
      expect(bindings).to.deep.equal([malicious]);
    });

    it('uses the request timeout', async () => {
      const model = await createGetModel({ requestTimeout: 1234 });
      await model.get({ id: 1 });

      expect(builder.toSQL().timeout).to.equal(1234);
    });

    it('does not mutate the where object', async () => {
      const model = await createGetModel();
      const where = { id: 1 };
      await model.get(where);

      expect(where).to.deep.equal({ id: 1 });
    });

    it('logs and rethrows query errors without logging filter values', async () => {
      const model = await createGetModel({}, { runError: new Error('query timed out') });
      const error = await rejectionOf(model.get({ email: 'test@example.com' }));

      expect(error.message).to.equal('query timed out');
      expect(logger.error).to.have.been.calledOnceWithExactly(
        'DB read error', { table: 'apps', columns: ['email'], error: 'query timed out' }
      );
    });

    it('continues to work after an error', async () => {
      const model = await createGetModel();
      run.onFirstCall().rejects(new Error('boom'));

      await rejectionOf(model.get({ id: 1 }));
      expect(await model.get({ id: 1 })).to.deep.equal(rows);
    });

    it('rejects invalid input without querying the DB', async () => {
      const model = await createGetModel();

      for (const where of [null, 'id = 1', [], { 'id; drop table apps': 1 }, { email: { $ne: '' } }]) {
        expect(await rejectionOf(model.get(where))).to.be.instanceOf(TypeError);
      }
      expect(run).to.not.have.been.called;
    });
  });

  describe('patch', () => {
    const rows = [{ id: 1, email: 'new@example.com' }];
    let run;
    let builder;

    const createPatchModel = async (options = {}, { runError } = {}) => {
      const { instance } = stubbedKnex();
      run = runError ? sinon.stub().rejects(runError) : sinon.stub().resolves(rows);
      sinon.stub(instance.client, 'runner').callsFake(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('updates the row by id using bound parameters and returns the selectable props', async () => {
      const model = await createPatchModel({ selectableProps: ['email'] });
      const result = await model.patch(1, { email: 'new@example.com' });
      const { sql, bindings } = builder.toSQL();

      expect(result).to.deep.equal(rows);
      expect(sql).to.equal(
        'update "apps" set "email" = ?, "updated_at" = CURRENT_TIMESTAMP where "id" = ? ' +
        'returning "id", "created_at", "updated_at", "email"'
      );
      expect(bindings).to.deep.equal(['new@example.com', 1]);
    });

    it('binds values as parameters rather than inlining them', async () => {
      const model = await createPatchModel();
      const malicious = "x'; DROP TABLE apps; --";
      await model.patch('abc', { email: malicious });
      const { sql, bindings } = builder.toSQL();

      expect(sql).to.not.include(malicious);
      expect(bindings).to.deep.equal([malicious, 'abc']);
    });

    it('uses the request timeout', async () => {
      const model = await createPatchModel({ requestTimeout: 4321 });
      await model.patch(1, { email: 'a@b.com' });

      expect(builder.toSQL().timeout).to.equal(4321);
    });

    it('overrides a supplied updated_at and does not mutate the input', async () => {
      const model = await createPatchModel();
      const fields = { email: 'a@b.com', updated_at: 'yesterday' };
      await model.patch(1, fields);

      expect(builder.toSQL().sql).to.include('"updated_at" = CURRENT_TIMESTAMP');
      expect(fields).to.deep.equal({ email: 'a@b.com', updated_at: 'yesterday' });
    });

    it('logs and rethrows query errors without logging values', async () => {
      const runError = Object.assign(new Error('query timed out'), { code: '57014' });
      const model = await createPatchModel({}, { runError });
      const error = await rejectionOf(model.patch(1, { email: 'a@b.com' }));

      expect(error.message).to.equal('query timed out');
      expect(logger.error).to.have.been.calledOnceWithExactly(
        'DB update error', { table: 'apps', columns: ['email'], code: '57014' }
      );
    });

    it('continues to work after an error', async () => {
      const model = await createPatchModel();
      run.onFirstCall().rejects(new Error('boom'));

      await rejectionOf(model.patch(1, { email: 'a@b.com' }));
      expect(await model.patch(1, { email: 'a@b.com' })).to.deep.equal(rows);
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
        expect(await rejectionOf(model.patch(id, fields))).to.be.instanceOf(TypeError);
      }
      expect(run).to.not.have.been.called;
      expect(logger.error).to.not.have.been.called;
    });
  });

  describe('create', () => {
    const rows = [{ id: 1, email: 'test@example.com' }];
    let instance;
    let run;
    let builder;

    const createModelForInsert = async (options = {}, { runError } = {}) => {
      ({ instance } = stubbedKnex());
      run = runError ? sinon.stub().rejects(runError) : sinon.stub().resolves(rows);
      sinon.stub(instance.client, 'runner').callsFake(query => {
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

      expect(result).to.deep.equal(rows);
      expect(sql).to.equal(
        'insert into "apps" ("email") values (?) returning "id", "created_at", "updated_at", "email"'
      );
      expect(bindings).to.deep.equal(['test@example.com']);
      expect(data).to.deep.equal({ email: 'test@example.com' });
    });

    it('uses the request timeout', async () => {
      const model = await createModelForInsert({ requestTimeout: 1234 });
      await model.create({ email: 'test@example.com' });

      expect(builder.toSQL().timeout).to.equal(1234);
    });

    it('logs and rethrows query errors without logging inserted values', async () => {
      const runError = Object.assign(new Error('insert failed'), { code: '23505' });
      const model = await createModelForInsert({}, { runError });
      const error = await rejectionOf(model.create({ email: 'sensitive@example.com' }));

      expect(error.message).to.equal('insert failed');
      expect(logger.error).to.have.been.calledOnceWithExactly(
        'DB create error', { table: 'apps', columns: ['email'], code: '23505' }
      );
      expect(logger.error.firstCall.args[1]).to.not.have.property('email');
    });

    it('rejects invalid or empty data without querying the DB', async () => {
      const model = await createModelForInsert();

      for (const data of [{}, null, 'email', { 'email; drop table apps': 'x' }, { email: { $ne: '' } }]) {
        expect(await rejectionOf(model.create(data))).to.be.instanceOf(TypeError);
      }
      expect(run).to.not.have.been.called;
      expect(logger.error).to.not.have.been.called;
    });
  });

  describe('delete', () => {
    let instance;
    let run;
    let builder;

    const createModelForDelete = async (options = {}, { runError } = {}) => {
      ({ instance } = stubbedKnex());
      run = runError ? sinon.stub().rejects(runError) : sinon.stub().resolves(1);
      sinon.stub(instance.client, 'runner').callsFake(query => {
        builder = query;
        return { run };
      });
      return createModel({ knex: instance, knexConfig, tableName: 'apps', logger, ...options });
    };

    it('deletes the row with the given id and returns the deleted count', async () => {
      const model = await createModelForDelete();
      const result = await model.delete(1);
      const { sql, bindings } = builder.toSQL();

      expect(result).to.equal(1);
      expect(sql).to.equal('delete from "apps" where "id" = ?');
      expect(bindings).to.deep.equal([1]);
    });

    it('accepts string ids and binds them as parameters', async () => {
      const model = await createModelForDelete();
      const malicious = "1' OR '1'='1";
      await model.delete(malicious);
      const { sql, bindings } = builder.toSQL();

      expect(sql).to.equal('delete from "apps" where "id" = ?');
      expect(bindings).to.deep.equal([malicious]);
    });

    it('returns 0 when no row matches', async () => {
      const model = await createModelForDelete();
      run.resolves(0);

      expect(await model.delete(999)).to.equal(0);
    });

    it('uses the request timeout', async () => {
      const model = await createModelForDelete({ requestTimeout: 1234 });
      await model.delete(1);

      expect(builder.toSQL().timeout).to.equal(1234);
    });

    it('logs and rethrows query errors with the error code only', async () => {
      // 57014 is PostgreSQL's query_canceled code, which is what a statement timeout raises.
      const runError = Object.assign(new Error('query timed out'), { code: '57014' });
      const model = await createModelForDelete({}, { runError });
      const error = await rejectionOf(model.delete(1));

      expect(error).to.equal(runError);
      expect(logger.error).to.have.been.calledOnceWithExactly(
        'DB delete error', { table: 'apps', code: '57014' }
      );
    });

    it('continues to work after an error', async () => {
      const model = await createModelForDelete();
      run.onFirstCall().rejects(new Error('boom'));

      await rejectionOf(model.delete(1));
      expect(await model.delete(1)).to.equal(1);
    });

    it('rejects invalid ids without querying the DB', async () => {
      const model = await createModelForDelete();

      for (const id of [undefined, null, 0, -1, 1.5, NaN, Infinity, '', '  ', {}, [], { id: 1 }, true]) {
        expect(await rejectionOf(model.delete(id))).to.be.instanceOf(TypeError);
      }
      expect(run).to.not.have.been.called;
      expect(logger.error).to.not.have.been.called;
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

describe('validateColumnValues', () => {
  it('returns a copy of a valid where object', () => {
    const date = new Date();
    const where = { email: 'test@example.com', id: 1, active: true, deleted_at: null, created_at: date };
    const result = validateColumnValues(where);

    expect(result).to.deep.equal(where);
    expect(result).to.not.equal(where);
  });

  it('accepts objects parsed from JSON and with a null prototype', () => {
    expect(validateColumnValues(JSON.parse('{"id":1}'))).to.deep.equal({ id: 1 });
    expect(validateColumnValues(Object.assign(Object.create(null), { id: 1 }))).to.deep.equal({ id: 1 });
  });

  it('rejects non plain objects', () => {
    for (const where of [undefined, null, 'id', 1, [], new Date(), new Map()]) {
      expect(() => validateColumnValues(where)).to.throw(TypeError, 'input must be a plain object');
    }
  });

  it('rejects invalid column names', () => {
    for (const column of ['', '1id', 'id;', 'id = 1', 'a.b', '"id"', 'id--']) {
      expect(() => validateColumnValues({ [column]: 1 })).to.throw(TypeError, 'Invalid column name');
    }
  });

  it('rejects unsupported values', () => {
    for (const value of [undefined, {}, [1], () => { }, NaN, Infinity, new Date('x'), Symbol('s'), 1n]) {
      expect(() => validateColumnValues({ id: value })).to.throw(TypeError, 'Invalid value for column "id"');
    }
  });
  it('rejects empty objects when requireNonEmpty is true', () => {
    expect(() => validateColumnValues({}, true)).to.throw(TypeError, 'input must contain at least one column');
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
