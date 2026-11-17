#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const [node, file] = process.argv.slice(2);
if (!node || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(node) || !file) throw Error('usage: contributor-key.ts <node-id> <new-private-key-file>');
const token = `cn1:${node}:${randomBytes(32).toString('base64url')}`;
await writeFile(file, `${token}\n`, { flag: 'wx', mode: 0o600 });
console.log(`TRAFFIC_CONTRIBUTOR_NODE_KEYS=${node}:${createHash('sha256').update(token).digest('hex')}`);
