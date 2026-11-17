#!/usr/bin/env node
import { signContributorToken } from '../src/contributor.ts';

const node = process.argv[2];
if (!node) throw Error('usage: contributor-token.ts <node-id>');
const token = signContributorToken(node);
if (!token) throw Error('valid node ID and TRAFFIC_CONTRIBUTOR_SECRET (at least 32 characters) required');
console.log(token);
