#!/usr/bin/env node
// Usage:  read -rs PASSWORD && export PASSWORD
//         node scripts/cli.js add-user admin@example.com "Alex" admin
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const [cmd, email, name, role] = process.argv.slice(2);
if (cmd !== 'add-user' || !email || !name || !['admin', 'driver'].includes(role) || !process.env.PASSWORD) {
  console.error('Usage: PASSWORD=... node scripts/cli.js add-user <email> <name> <admin|driver>');
  process.exit(1);
}

const hash = bcrypt.hashSync(process.env.PASSWORD, 10);
db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
  .run(email.trim(), name.trim(), hash, role);
console.log(`Created ${role} account for ${email}`);
