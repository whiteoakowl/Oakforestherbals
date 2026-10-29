'use strict';
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}
const app = require('./src/app');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Store running at http://localhost:${port}`);
  console.log(`Admin dashboard at http://localhost:${port}/admin`);
});
