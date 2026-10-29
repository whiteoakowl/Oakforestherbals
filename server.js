'use strict';
const app = require('./src/app');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Store running at http://localhost:${port}`);
  console.log(`Admin dashboard at http://localhost:${port}/admin`);
});
