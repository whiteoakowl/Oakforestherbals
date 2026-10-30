'use strict';
// The whole store (storefront, checkout, admin) runs as one Netlify Function.
// netlify.toml rewrites every non-static request here.
const serverless = require('serverless-http');
const app = require('../../src/app');

exports.handler = serverless(app, {
  basePath: '/.netlify/functions/server',
  binary: ['image/*', 'application/octet-stream', 'application/pdf'],
});
