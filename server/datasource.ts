import 'reflect-metadata';
import type { DataSourceOptions, EntityTarget, Repository } from 'typeorm';
import { DataSource } from 'typeorm';

const devConfig: DataSourceOptions = {
  type: 'sqlite',
  database: process.env.CONFIG_DIRECTORY
    ? `${process.env.CONFIG_DIRECTORY}/db/db.sqlite3`
    : 'config/db/db.sqlite3',
  synchronize: true,
  migrationsRun: false,
  logging: false,
  enableWAL: true,
  entities: ['server/entity/**/*.ts'],
  migrations: ['server/migration/**/*.ts'],
  subscribers: ['server/subscriber/**/*.ts'],
};

const prodConfig: DataSourceOptions = {
  type: 'sqlite',
  database: process.env.CONFIG_DIRECTORY
    ? `${process.env.CONFIG_DIRECTORY}/db/db.sqlite3`
    : 'config/db/db.sqlite3',
  synchronize: false,
  migrationsRun: false,
  logging: false,
  enableWAL: true,
  entities: ['dist/entity/**/*.js'],
  migrations: ['dist/migration/**/*.js'],
  subscribers: ['dist/subscriber/**/*.js'],
};

const dataSource = new DataSource(
  process.env.NODE_ENV !== 'production' ? devConfig : prodConfig
);

export const getRepository = <Entity extends object>(
  target: EntityTarget<Entity>
): Repository<Entity> => {
  return dataSource.getRepository(target);
};

/**
 * Repository.remove() deletes many entities with one statement whose WHERE
 * clause grows with the entity count; past ~1000 rows SQLite rejects it
 * ("Expression tree is too large"). Remove in bounded chunks instead.
 */
export const removeInChunks = async <Entity extends object>(
  repository: Repository<Entity>,
  entities: Entity[],
  chunkSize = 200
): Promise<void> => {
  for (let i = 0; i < entities.length; i += chunkSize) {
    await repository.remove(entities.slice(i, i + chunkSize));
  }
};

export default dataSource;
