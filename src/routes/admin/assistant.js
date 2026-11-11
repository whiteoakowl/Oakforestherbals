'use strict';
// The AI assistant page. One question at a time, optionally following up on the previous answer
// (carried in the form, so nothing — including any patient detail — is stored on the server).
const express = require('express');
const assistant = require('../../assistant');
const audit = require('../../audit');

const router = express.Router();
const text = (v, max) => String(v || '').trim().slice(0, max);

function render(res, extra = {}) {
  const tools = assistant.toolsFor(res.locals.staff).map((t) => t.name);
  res.render('admin/assistant', { title: 'Assistant', configured: assistant.configured(), tools, question: '', result: null, error: '', previous: null, ...extra });
}

router.get('/', (req, res) => render(res));

router.post('/', async (req, res) => {
  const question = text(req.body.question, 2000);
  if (!question) return render(res, { error: 'Type a question.' });
  const previous = req.body.follow_up === '1' ? { question: text(req.body.prev_question, 2000), answer: text(req.body.prev_answer, 8000) } : null;
  try {
    const result = await assistant.ask(res.locals.staff, question, previous);
    // Record that it was used and which look-ups ran — never the question or answer.
    await audit.record(req, 'assistant.asked', { entityType: 'assistant', details: { tools: result.tools } });
    render(res, { question, result });
  } catch (err) {
    if (err.status === 503) return render(res, { question, error: err.message });
    console.error('Assistant error:', err.message);
    render(res, { question, error: 'The assistant could not answer right now. Try again in a moment.' });
  }
});

module.exports = router;
