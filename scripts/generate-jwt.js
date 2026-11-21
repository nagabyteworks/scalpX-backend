import 'dotenv/config';
import jwt from 'jsonwebtoken';

const secret = process.env.APP_JWT_SECRET || 'super_secret_hs256_key_change_in_production';
const token = jwt.sign(
  { sub: 'scalpx-trader', role: 'owner' },
  secret,
  { algorithm: 'HS256', expiresIn: '365d' }
);

console.log('\n========================================');
console.log('Your Personal scalpX JWT Token:');
console.log('========================================\n');
console.log(token);
console.log('\n========================================\n');
