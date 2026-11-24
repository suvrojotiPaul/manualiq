// Chat state: one Claude session per chat, per-turn retrieval state, a per-chat lock, and JSONL logs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const STATE_FILE = path.join(config.stateDir, 'chats.json');
let chats = {};
try { chats = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { chats = {}; }

let saveTimer = null;
function save() { // debounced, atomic write
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(chats, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

export const newId = () => crypto.randomUUID();

export function getChat(chatId) {
  if (!chatId || !chats[chatId]) {
    chatId = newId();
    chats[chatId] = { id: chatId, sessionId: crypto.randomUUID(), started: false, createdAt: new Date().toISOString(), turns: [] };
    save();
  }
  return chats[chatId];
}

export function addTurn(chat, turn) {
  chat.turns.push(turn);
  chat.updatedAt = new Date().toISOString();
  save();
}

export function updateChat(chat, patch) { Object.assign(chat, patch); save(); }

export function findTurn(chat, msgId) { return chat.turns.find(t => t.msgId === msgId); }

/** The last turn that asked an actual question (not more/shorter/retry). */
export function lastQuestionTurn(chat) {
  return [...chat.turns].reverse().find(t => t.action === 'ask' || t.action === 'followup');
}

// --- one turn at a time per chat (two processes resuming the same Claude session would clash)
const locks = new Map();
export function withChatLock(chatId, fn) {
  const prev = locks.get(chatId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(chatId, next);
  next.finally(() => { if (locks.get(chatId) === next) locks.delete(chatId); }).catch(() => {});
  return next;
}

// --- logs (input for the cross-chat learning step, PLAN.md 5b)
export function log(kind, record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  fs.appendFile(path.join(config.logsDir, `${kind}.jsonl`), line, () => {});
}
