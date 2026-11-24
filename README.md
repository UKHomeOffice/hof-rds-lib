# hof-rds-lib

RDS integration library replacing the hof-rds-api sidecar.

## Requirements

- Node.js

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

### `model.getInTimeRange(options)`

Async. Returns rows whose timestamp column falls within an inclusive time range (both `from` and `to` are included). Uses the `requestTimeout` supplied when the model was initialised. Returns an empty array when nothing matches. This follows the `hof-rds-api` history query contract.

| Option | Default | Description |
| --- | --- | --- |
| `timestamp` | required | Timestamp column to filter, e.g. `'created_at'` or `'updated_at'` |
| `from` | required | Lower bound: a valid `Date` or parseable date string |
| `to` | database current time | Upper bound: a valid `Date` or parseable date string; must not precede `from` |
| `withValue` | omitted | Only include rows where this column is not `NULL` (empty strings still match) |
| `selectableProps` | model's configured columns | Per-call comma-separated column names, appended to `id`, `created_at`, `updated_at`; `'*'` selects all columns |

```js
const rows = await model.getInTimeRange({
  timestamp: 'created_at',
  from: '2026-02-01T00:00:00.000Z',
  to: '2026-02-05T00:00:00.000Z',
  withValue: 'email',
  selectableProps: 'email,session'
});

try {
  const recent = await model.getInTimeRange({
    timestamp: 'updated_at',
    from: new Date('2026-02-01T00:00:00.000Z')
  }); // through the database's current time
  console.log(recent);
} catch (error) {
  console.error(error.message);
  // Invalid input, DB errors and timeouts reject; subsequent calls can still be made.
}
```

- Uses Knex's `whereBetween`, optional `whereNotNull`, and `fn.now()` builders, with no raw SQL. Date bounds are bound as parameters. Prefer ISO 8601 strings with an explicit timezone (as above) to avoid ambiguous dates; a date-only upper bound means midnight, not the end of that day.
- Options must be a plain object. Column names, including per-call selections, must match `[A-Za-z_][A-Za-z0-9_]*` (except a standalone `'*'` selection). Missing required options, invalid dates, reversed explicit bounds and invalid column names reject with a `TypeError` before querying. Optional fields must be omitted or `undefined`, not `null` or empty strings.
- Per-call selections do not mutate the options or the model's configured columns. Like the upstream API, they override the model selection, not an authorisation boundary; restrict caller-controlled selections in the consuming service as needed.
- DB errors and timeouts are rethrown with their original messages. Logs contain only the table and error code, not date bounds, row values or DB error messages. The model remains usable after an error.

### `model.getCount(where)`

Async. Returns the number of rows in the model's table matching every key/value pair in `where` (combined with `AND`). Omit `where` or pass `{}` to count all rows. Returns `0` when no rows match. PostgreSQL count strings are converted to JavaScript numbers; counts above `Number.MAX_SAFE_INTEGER` may lose precision. The count is independent of `selectableProps` and uses the `requestTimeout` supplied when the model was initialised (default `10000` ms).

```js
const total = await model.getCount();
const matching = await model.getCount({ email: 'test@example.com' });
const withoutSession = await model.getCount({ email: 'test@example.com', session: null });

try {
  const count = await model.getCount({ email: 'test@example.com' });
  console.log(count); // a number, e.g. 2
} catch (error) {
  console.error(error.message);
  // Invalid input, DB errors and timeouts reject; subsequent calls can still be made.
}
```

- Uses Knex's `count` query builder, not raw SQL. Filter values are bound as parameters, and `null` becomes `IS NULL`.
- `where` must be a plain object with valid column-name keys (`[A-Za-z_][A-Za-z0-9_]*`). Values must be strings, finite numbers, booleans, valid `Date` objects or `null`. Invalid input rejects with a `TypeError` before querying the DB; inputs are not mutated.
- DB errors and timeouts are rethrown to the caller. Logging includes only the table, filtered column names and error code, not filter values or potentially sensitive DB error messages. The model remains usable after an error.

### `model.getMetrics(where)`

Async. Returns size metrics for the model's table and its database, plus the number of rows matching `where`. This replaces the `hof-rds-api` metrics endpoint and returns the same shape. Both queries use the `requestTimeout` supplied when the model was initialised (default `10000` ms) and run in parallel.

| Field | Description |
| --- | --- |
| `table_name` | the model's table |
| `table_size` | total size of the table including indexes and TOAST data, human readable (e.g. `'48 kB'`) |
| `database_name` | the connected database |
| `database_size` | total size of the database, human readable (e.g. `'7621 kB'`) |
| `row_count` | number of rows matching `where` (all rows when omitted), as a number |

```js
const metrics = await model.getMetrics();
// {
//   table_name: 'saved_applications',
//   table_size: '48 kB',
//   database_name: 'hof',
//   database_size: '7621 kB',
//   row_count: 12
// }

try {
  const { row_count } = await model.getMetrics({ email: 'test@example.com' });
  console.log(row_count); // rows for that email only
} catch (error) {
  console.error(error.message);
  // Invalid input, DB errors and timeouts reject; subsequent calls can still be made.
}
```

- PostgreSQL only. Sizes come from `pg_size_pretty`, `pg_total_relation_size` and `pg_database_size`, read from `pg_catalog.pg_stat_user_tables` for the table in the current schema.
- Uses the knex query builder (`first`, `where`, `count`) rather than raw SQL statements. knex has no builder for PostgreSQL functions, so those function calls are fixed `knex.raw` fragments containing no caller input; the table name and filter values are always bound as parameters.
- `where` is validated like `getCount`: a plain object with valid column-name keys (`[A-Za-z_][A-Za-z0-9_]*`) and string, finite number, boolean, valid `Date` or `null` values. Invalid input rejects with a `TypeError` before querying the DB; inputs are not mutated.
- DB errors and timeouts are rethrown to the caller. If the table's metrics cannot be found, it rejects with an `Error`. Logging includes only the table, filtered column names and error code, never filter values. The model remains usable after an error.

### `model.patch(id, fields)`

Async. Updates the row whose `id` matches, setting each column in `fields` and refreshing `updated_at`. Resolves with an array of the updated rows (only the model's `selectableProps`), which is empty if no row matched. The query uses the model's `requestTimeout`.

```js
const [updated] = await model.patch(42, { email: 'new@example.com' });
// UPDATE saved_applications SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, created_at, updated_at, session, email

try {
  await model.patch(42, { email: 'new@example.com' });
} catch (error) {
  // timeouts and DB errors reject with an Error; the model remains usable
}
```

- The query is built with the knex query builder (no raw SQL) and values are bound as parameters.
- `id` must be a string or finite number. `fields` is validated like `create` data: a non-empty plain object with valid column names and supported values (string, finite number, boolean, valid `Date` or `null`). Anything else rejects with a `TypeError` before the DB is queried.
- `updated_at` is always set by the database and overrides any supplied value.
- DB errors are logged with the table and the column names (never the values), then rethrown to the caller.

### `model.delete(id)`

Async. Deletes the row with the given `id` from the model's table and resolves with the number of rows deleted (`0` if no row matched). The query uses the model's `requestTimeout`.

```js
const deleted = await model.delete(1);
// DELETE FROM saved_applications WHERE id = 1

if (deleted === 0) {
  // no row with that id
}

try {
  await model.delete(1);
} catch (error) {
  // timeouts, DB errors and invalid input reject with an Error; the model remains usable
}
```

- The query is built with the knex query builder (no raw SQL) and the id is bound as a parameter.
- `id` must be a positive integer or a non-empty string. Anything else rejects with a `TypeError` before the DB is queried.
- DB errors are logged with the table and error code (never the id or error message), then rethrown to the caller.

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

Integration tests start MiniStack automatically with Testcontainers, use its RDS API to provision a real PostgreSQL instance, then connect to its returned endpoint with Knex. Docker must be running, with access to `/var/run/docker.sock` so MiniStack can start the RDS database container. Run:

```bash
yarn test:integration
```

The tests create and delete their own RDS instance.
