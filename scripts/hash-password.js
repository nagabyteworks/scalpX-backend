import readline from 'node:readline';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';

let muted = false;
const mutableStdout = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) {
      process.stdout.write(chunk, encoding);
    }
    callback();
  },
});

const rl = readline.createInterface({
  input: process.stdin,
  output: mutableStdout,
  terminal: true,
});

process.stdout.write('Enter Flattrade Password: ');
muted = true;

rl.question('', (password) => {
  muted = false;
  process.stdout.write('\n');
  rl.close();

  const trimmed = password.trim();
  if (!trimmed) {
    console.error('❌ Error: Password cannot be empty.');
    process.exit(1);
  }

  const hash = crypto.createHash('sha256').update(trimmed).digest('hex').toLowerCase();

  console.log('\n========================================================================');
  console.log('✅ Generated FLATTRADE_PASSWORD_SHA256 (64-char lowercase hex):');
  console.log('========================================================================\n');
  console.log(hash);
  console.log('\n========================================================================');
  console.log('Paste this hash into /etc/flattrade-engine/env or your .env file:');
  console.log(`FLATTRADE_PASSWORD_SHA256=${hash}`);
  console.log('========================================================================\n');
});
