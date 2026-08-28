const { getDb } = require('../database/db');

/**
 * Catat aktivitas ke tabel activity_logs.
 * Dipanggil dari route handler saat ada aksi penting.
 */
function logActivity({ user, module, action, description, entity_type = null, entity_id = null, metadata = null }) {
  try {
    const db = getDb();
    const userId = user?.id || null;
    const userName = user?.full_name || user?.username || 'Sistem';
    const meta = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;
    db.prepare(
      'INSERT INTO activity_logs (user_id,user_name,module,action,description,entity_type,entity_id,metadata) VALUES (?,?,?,?,?,?,?,?)'
    ).run(userId, userName, module, action, description || '', entity_type, entity_id, meta);
  } catch (e) {
    console.error('logActivity error:', e.message);
  }
}

module.exports = { logActivity };
