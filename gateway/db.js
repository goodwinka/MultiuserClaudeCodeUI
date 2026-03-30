'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = '/var/lib/multiuser-ccui';
const DB_PATH = path.join(DB_DIR, 'users.db');

let db;

function init() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT    NOT NULL UNIQUE,
      password_hash TEXT   NOT NULL,
      role         TEXT    NOT NULL DEFAULT 'user',
      uid          INTEGER NOT NULL UNIQUE,
      blocked      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT OR IGNORE INTO meta (key, value) VALUES ('next_uid', '10000');
  `);

  // Migration: add settings column if it doesn't exist yet
  try {
    db.exec(`ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`);
  } catch { /* column already exists */ }
}

function nextUid() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'next_uid'").get();
  const uid = parseInt(row.value, 10);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'next_uid'").run(String(uid + 1));
  return uid;
}

function createUser(username, passwordHash, role, uid) {
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, role, uid) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(username, passwordHash, role, uid);
  return { id: info.lastInsertRowid, username, role, uid };
}

function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getAllUsers() {
  return db.prepare('SELECT id, username, role, uid, blocked, created_at FROM users ORDER BY id').all();
}

function blockUser(id, value) {
  db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(value, id);
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function updateRole(id, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

function updatePassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

function getUserSettings(id) {
  const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(id);
  if (!row) return {};
  try { return JSON.parse(row.settings || '{}'); } catch { return {}; }
}

function updateUserSettings(id, settings) {
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
}

module.exports = { init, nextUid, createUser, findByUsername, getUserById, getAllUsers, blockUser, deleteUser, updateRole, updatePassword, getUserSettings, updateUserSettings };
