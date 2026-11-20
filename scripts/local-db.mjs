import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
export function localDatabase(filename=':memory:') {
  const sqlite=new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)');
  for(const name of readdirSync(path.resolve(import.meta.dirname,'../migrations')).filter(name=>name.endsWith('.sql')).sort()){
    if(sqlite.prepare('SELECT name FROM local_migrations WHERE name=?').get(name))continue;
    sqlite.exec('BEGIN');
    try{sqlite.exec(readFileSync(path.resolve(import.meta.dirname,'../migrations',name),'utf8'));sqlite.prepare('INSERT INTO local_migrations VALUES(?)').run(name);sqlite.exec('COMMIT');}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }
  function prepare(sql){const statement=sqlite.prepare(sql);let parameters=[];return {bind(...values){parameters=values;return this;},first(){return statement.get(...parameters)||null;},all(){return {results:statement.all(...parameters)};},run(){const result=statement.run(...parameters);return {meta:{changes:Number(result.changes)}};}};}
  return {prepare,async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}},close(){sqlite.close();},raw:sqlite};
}
