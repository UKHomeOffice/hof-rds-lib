# hof-rds-lib

RDS integration library replacing the hof-rds-api sidecar.

## Requirements

- Node.js `>=24.21.0 <25.0.0`

## Install

```bash
yarn install
```

## Structure

```
index.js        # public entry point
lib/
  logger.js     # winston logger factory
  model.js      # knex-backed table model factory
```

## Model

A factory that initiates and verifies a DB connection for a given table, returning an object used to interact with it.

```js
import knex from 'knex';
import { createModel } from 'hof-rds-lib';

const model = await createModel({
  knex,                       // knex module or an existing knex instance
  knexConfig,                 // e.g. require('./knexfile')[env]
  tableName: 'saved_applications',
  requestTimeout: 5000,
  selectableProps: ['session', 'email']
});
```

| Option | Default | Description |
| --- | --- | --- |
| `knex` | required | knex module (called with `knexConfig`) or a knex instance |
| `knexConfig` | required | knex config for the connection |
| `tableName` | required | table to interact with |
| `requestTimeout` | `10000` | query timeout in ms |
| `selectableProps` | `['id', 'created_at', 'updated_at']` | columns to select, appended to the defaults; `['*']` selects all |
| `logger` | `loggerFactory()` | winston logger |

Connection attempts, successes, failures (table not found) and errors are logged with the client, host, port, database and table (credentials are never logged). The promise rejects on failure or error.

### `model.get(where)`

Async. Returns all rows from the model's table matching every key/value pair in `where` (combined with `AND`). Only the model's `selectableProps` columns are returned, and the query uses the model's `requestTimeout`.

```js
const rows = await model.get({ email: 'test@example.com' });
// SELECT id, created_at, updated_at, session, email FROM saved_applications WHERE email = 'test@example.com'

const all = await model.get(); // no criteria returns every row

try {
  await model.get({ email: 'test@example.com', session_id: null }); // null becomes IS NULL
} catch (error) {
  // timeouts, DB errors and invalid input reject with an Error; the model remains usable
}
```

- The query is built with the knex query builder (no raw SQL) and values are bound as parameters.
- `where` must be a plain object. Keys must be valid column names (`[A-Za-z_][A-Za-z0-9_]*`) and values must be a string, finite number, boolean, valid `Date` or `null`. Anything else rejects with a `TypeError` before the DB is queried.
- DB errors are logged with the table and the filtered column names (never the filter values), then rethrown to the caller.

## Logger

A factory that returns a configured [winston](https://github.com/winstonjs/winston) logger, used for CRUD operations and DB connection logging.

```js
import { loggerFactory } from 'hof-rds-lib';

const logger = loggerFactory({ label: 'rds' });

logger.info('connected to db', { host, database });
logger.debug('CREATE row', { table, id });
logger.logSession(sessionId)('info', 'updated %s rows', count);
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `env` | `process.env.NODE_ENV` | `production`/`development` log as JSON, anything else is colourised; `test` is silent |
| `loglevel` | `process.env.LOG_LEVEL` or `info` | winston level, or `silent` to disable output |
| `label` | `hof-rds-lib` | label attached to every log entry |

`logger.stream` is also exposed for request logging middleware.

## Tests

```bash
yarn test              # lint, integration and unit tests
yarn test:lint         # eslint with eslint-config-hof
yarn test:unit         # test/_unit, with coverage
yarn test:integration  # test/_integration, with coverage
```

Integration tests that need a database are skipped unless `DB_NAME` is set. They also read `DB_HOST`, `DB_PORT`, `DB_USER` and `DB_PASS`, and create and drop a temporary table:

```bash
DB_NAME=postgres DB_USER=$(whoami) yarn test:integration
```
