import fs from 'fs';
import path from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { LEGACY_LABEL_PREFIX } from './lib/collections/core/labelPrefix';

const LOG_DIRECTORY = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/logs`
  : path.join(__dirname, '../config/logs');

// Migrate away from the log symlink written under the legacy name
const OLD_LOG_FILE = path.join(
  LOG_DIRECTORY,
  `${LEGACY_LABEL_PREFIX.toLowerCase()}.log`
);
if (fs.lstatSync(OLD_LOG_FILE, { throwIfNoEntry: false })) {
  fs.unlinkSync(OLD_LOG_FILE);
}

// Plex URLs carry the admin token as a query parameter; never write it to logs
const TOKEN_PATTERN = /(X-Plex-Token=|[?&]token=)[^&\s"']+/gi;

const redact = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return value.replace(TOKEN_PATTERN, '$1[REDACTED]');
  }
  if (depth > 5 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (value.constructor !== Object) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redact(v, depth + 1);
  }
  return out;
};

const SPLAT = Symbol.for('splat');

const redactSecrets = winston.format((info) => {
  for (const key of Object.keys(info)) {
    info[key] = redact(info[key]);
  }
  // Transports that run splat() again re-merge the raw metadata from here
  const splat = (info as unknown as Record<symbol, unknown>)[SPLAT];
  if (Array.isArray(splat)) {
    (info as unknown as Record<symbol, unknown>)[SPLAT] = redact(splat);
  }
  return info;
});

const hformat = winston.format.printf(
  ({ level, label, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]${
      label ? `[${label}]` : ''
    }: ${message} `;
    if (Object.keys(metadata).length > 0) {
      try {
        msg += JSON.stringify(metadata);
      } catch (error) {
        // Handle circular references by using a replacer function
        msg += JSON.stringify(metadata, (key, value) => {
          if (typeof value === 'object' && value !== null) {
            // For Error objects, extract useful properties
            if (value instanceof Error) {
              return {
                name: value.name,
                message: value.message,
                stack: value.stack,
              };
            }
            // Skip circular references and complex objects like HTTP agents
            if (
              value.constructor &&
              (value.constructor.name === 'Agent' ||
                value.constructor.name === 'ClientRequest')
            ) {
              return '[Circular Reference]';
            }
          }
          return value;
        });
      }
    }
    return msg;
  }
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'debug',
  format: winston.format.combine(
    winston.format.splat(),
    redactSecrets(),
    winston.format.timestamp(),
    hformat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.splat(),
        winston.format.timestamp(),
        hformat
      ),
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_DIRECTORY, 'posterarr-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '7d',
      createSymlink: true,
      symlinkName: 'posterarr.log',
    }),
    new winston.transports.DailyRotateFile({
      filename: process.env.CONFIG_DIRECTORY
        ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs-%DATE%.json`
        : path.join(__dirname, '../config/logs/.machinelogs-%DATE%.json'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '1d',
      createSymlink: true,
      symlinkName: '.machinelogs.json',
      format: winston.format.combine(
        winston.format.splat(),
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
  ],
});

export default logger;
