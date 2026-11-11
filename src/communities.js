'use strict';
// Community spaces for group programs: a private discussion board for invited clients and the
// practitioner leading it. Clients join only after accepting the group guidelines and choosing how
// their name appears; posts are encrypted like other clinic content; staff can pin, hide and remove.
const { get, all, run, insert } = require('./db');
const vault = require('./vault');

const DEFAULT_GUIDELINES = `Be kind and supportive; everyone is at a different point.
Share only what you're comfortable with — other members will see it.
Keep what others share inside this group.
This group isn't medical advice and isn't for emergencies. For urgent help, contact your doctor or emergency services. For questions about your own care, message your practitioner privately.
No selling or promotion.`;

const defaultName = (p) => `${p.first_name || ''} ${(p.last_name || '').slice(0, 1)}${p.last_name ? '.' : ''}`.trim() || 'Member';

// The client's membership (accepted or not), or null if they aren't invited or were removed.
const membership = (communityId, patientId) => get('SELECT m.*, c.name AS community_name, c.status AS community_status, c.guidelines FROM community_members m JOIN communities c ON c.id = m.community_id WHERE m.community_id = ? AND m.patient_id = ? AND m.removed_at IS NULL AND c.status != \'archived\'', communityId, patientId);

const forPatient = (patientId) => all(`SELECT c.*, m.accepted_at, m.id AS member_id, m.last_seen_at,
    (SELECT COUNT(*) FROM community_posts p WHERE p.community_id = c.id AND p.hidden = 0 AND p.created_at > COALESCE(m.last_seen_at, m.invited_at)) AS new_posts
  FROM community_members m JOIN communities c ON c.id = m.community_id WHERE m.patient_id = ? AND m.removed_at IS NULL AND c.status != 'archived' ORDER BY c.name`, patientId);

// Posts with their replies, newest thread first; pinned threads at the top.
async function feed(communityId, { includeHidden = false } = {}) {
  const rows = await all(`SELECT p.*, m.patient_id FROM community_posts p LEFT JOIN community_members m ON m.id = p.member_id
    WHERE p.community_id = ? ${includeHidden ? '' : 'AND p.hidden = 0'} ORDER BY p.created_at`, communityId);
  const posts = rows.map((r) => ({ ...r, body: (vault.open(r.body_enc) || {}).text || '' }));
  const threads = posts.filter((p) => !p.parent_id).map((p) => ({ ...p, replies: posts.filter((r) => r.parent_id === p.id) }));
  return threads.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.created_at) - new Date(a.created_at)));
}

async function post({ communityId, parentId = null, memberId = null, staffId = null, authorName, text }) {
  const body = String(text || '').trim().slice(0, 5000);
  if (!body) return null;
  if (parentId && !(await get('SELECT 1 FROM community_posts WHERE id = ? AND community_id = ? AND parent_id IS NULL AND hidden = 0', parentId, communityId))) return null;
  return insert('INSERT INTO community_posts (community_id, parent_id, member_id, staff_id, author_name, body_enc) VALUES (?, ?, ?, ?, ?, ?)',
    communityId, parentId, memberId, staffId, String(authorName).slice(0, 80), vault.seal({ text: body }));
}

const touch = (memberId) => run('UPDATE community_members SET last_seen_at = now() WHERE id = ?', memberId);

module.exports = { DEFAULT_GUIDELINES, defaultName, membership, forPatient, feed, post, touch };
