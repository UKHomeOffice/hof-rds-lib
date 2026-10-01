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
```

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
yarn test
```
