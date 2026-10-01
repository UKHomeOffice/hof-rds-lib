import util from 'node:util';
import winston from 'winston';

const { createLogger, format, transports } = winston;
const { combine, timestamp, colorize, simple, json, label: labelFormat } = format;

/**
 * Creates a winston logger for RDS CRUD and connection logging.
 *
 * @param {object} [config]
 * @param {string} [config.env] - node environment, defaults to NODE_ENV
 * @param {string} [config.loglevel] - winston level, or 'silent' to disable output
 * @param {string} [config.label] - label attached to every log entry
 * @returns {import('winston').Logger}
 */
export default function loggerFactory(config = {}) {
  const env = config.env || process.env.NODE_ENV || 'development';
  const loglevel = config.loglevel || process.env.LOG_LEVEL || 'info';
  const label = config.label || 'hof-rds-lib';

  const notProd = env !== 'production';
  const isLocal = notProd && env !== 'development';

  const consoleFormat = isLocal ? combine(colorize(), simple()) : json();

  const loggerConfig = {
    format: combine(labelFormat({ label }), timestamp()),
    exitOnError: false,
    transports: [
      new transports.Console({
        format: consoleFormat,
        silent: loglevel === 'silent' || env === 'test',
        level: loglevel === 'silent' ? 'error' : loglevel
      })
    ]
  };

  if (!notProd) {
    loggerConfig.exceptionHandlers = [new transports.Console({ format: consoleFormat })];
  }

  const logger = createLogger(loggerConfig);

  logger.stream = {
    write: message => {
      if (loglevel === 'debug') {
        logger.debug(message);
      } else {
        logger.info(message);
      }
    }
  };

  logger.logSession = id => (level, ...args) =>
    logger.log(level, `sessionId=${id} ${util.format(...args)}`);

  return logger;
}

export { loggerFactory };
