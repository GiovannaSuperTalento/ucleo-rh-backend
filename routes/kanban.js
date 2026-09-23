const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

function getUserIdFromReq(req) {
  if (req.user && req.user.id) return req.user.id;
  
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  
  const token = authHeader.split(' ')[1];
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.id || decoded.userId || decoded.sub || null;
  } catch (err) {
    return null;
  }
}

function getUserEmailFromReq(req) {
  if (req.user && req.user.email) return req.user.email;

  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const token = authHeader.split(' ')[1];
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.email || null;
  } catch (err) {
    return null;
  }
}

router.get('/workspaces/:id/kanban', async (req, res) => {
  let { id } = req.params;
  try {
    if (id === 'default') {
      const defaultWorkspace = await db.query('SELECT id FROM workspaces LIMIT 1');
      if (defaultWorkspace.rows.length === 0) {
        return res.status(404).json({ message: 'No existe ningún espacio de trabajo' });
      }
      id = defaultWorkspace.rows[0].id;
    }

    const workspaceRes = await db.query(
      'SELECT id, title, description FROM workspaces WHERE id = $1',
      [id]
    );

    if (workspaceRes.rows.length === 0) {
      return res.status(404).json({ message: 'Espacio de trabajo no encontrado' });
    }

    const columnsRes = await db.query(
      'SELECT id, title, position FROM kanban_columns WHERE workspace_id = $1 ORDER BY position ASC',
      [id]
    );

    const tasksRes = await db.query(
      `SELECT t.id, t.column_id, t.title, t.description, t.priority, t.color, t.due_date, t.has_alarm, t.position 
       FROM tasks t
       JOIN kanban_columns c ON t.column_id = c.id
       WHERE c.workspace_id = $1
       ORDER BY t.position ASC`,
      [id]
    );

    const columns = columnsRes.rows.map(col => ({
      ...col,
      tasks: tasksRes.rows.filter(task => task.column_id === col.id)
    }));

    res.json({ ...workspaceRes.rows[0], columns });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

router.post('/tasks', async (req, res) => {
  const { column_id, title, description, priority, color, due_date, has_alarm } = req.body;
  const userId = getUserIdFromReq(req);

  if (!column_id || !title) {
    return res.status(400).json({ message: 'El título y la columna son obligatorios' });
  }

  try {
    const posRes = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM tasks WHERE column_id = $1',
      [column_id]
    );
    const nextPosition = posRes.rows[0].next_pos;

    const insertQuery = `
      INSERT INTO tasks (column_id, title, description, priority, color, due_date, has_alarm, position, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    const values = [
      column_id,
      title,
      description || null,
      priority || 'media',
      color || '#FEF08A',
      due_date || null,
      has_alarm || false,
      nextPosition,
      userId || null
    ];

    const newTask = await db.query(insertQuery, values);
    res.status(201).json(newTask.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al crear la tarea' });
  }
});

router.put('/tasks/:id/move', async (req, res) => {
  const { id } = req.params;
  const { column_id, position } = req.body;

  if (!column_id) {
    return res.status(400).json({ message: 'La nueva columna es requerida' });
  }

  try {
    const updateQuery = `
      UPDATE tasks 
      SET column_id = $1, position = COALESCE($2, position)
      WHERE id = $3
      RETURNING *
    `;
    const result = await db.query(updateQuery, [column_id, position, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Tarea no encontrada' });
    }

    res.json({ message: 'Tarea movida con éxito', task: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al mover la tarea' });
  }
});

router.put('/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, color, priority, due_date } = req.body;
  try {
    const result = await db.query(
      `UPDATE tasks 
       SET title = COALESCE($1, title), 
           description = COALESCE($2, description), 
           color = COALESCE($3, color),
           priority = COALESCE($4, priority),
           due_date = COALESCE($5, due_date)
       WHERE id = $6 RETURNING *`,
      [title, description, color, priority, due_date, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Tarea no encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al actualizar la nota' });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM tasks WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Tarea no encontrada' });
    }
    res.json({ message: 'Nota eliminada con éxito' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al eliminar la nota' });
  }
});

router.get('/notifications/upcoming', async (req, res) => {
  try {
    const query = `
      SELECT id, title, due_date, priority 
      FROM tasks 
      WHERE has_alarm = TRUE 
        AND due_date IS NOT NULL 
        AND due_date >= NOW()
      ORDER BY due_date ASC 
      LIMIT 5
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al obtener las alarmas' });
  }
});

router.get('/my-profile', async (req, res) => {
  const userEmail = getUserEmailFromReq(req); 
  try {
    const result = await db.query('SELECT * FROM employees WHERE personal_email = $1', [userEmail]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Perfil no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al cargar perfil' });
  }
});

router.get('/messages/contacts', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.email, e.first_name, e.last_name, e.position, e.photo_url 
      FROM users u
      LEFT JOIN employees e ON u.email = e.personal_email
      ORDER BY e.first_name ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al obtener contactos' });
  }
});

router.get('/messages/unread/count', async (req, res) => {
  const currentUserId = getUserIdFromReq(req);

  if (!currentUserId) return res.status(401).json({ count: 0 });

  try {
    const result = await db.query(`
      SELECT COUNT(*) as count 
      FROM direct_messages 
      WHERE receiver_id = $1 AND (read = FALSE OR read IS NULL)
    `, [currentUserId]);

    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ count: 0 });
  }
});

router.put('/messages/read/:contactId', async (req, res) => {
  const { contactId } = req.params;
  const currentUserId = getUserIdFromReq(req);

  if (!currentUserId) return res.status(401).json({ message: 'No autenticado' });

  try {
    await db.query(`
      UPDATE direct_messages 
      SET read = TRUE 
      WHERE sender_id = $1 AND receiver_id = $2
    `, [contactId, currentUserId]);

    res.json({ message: 'Mensajes marcados como leídos' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al actualizar lectura' });
  }
});

router.get('/messages/:contactId', async (req, res) => {
  const { contactId } = req.params;
  const currentUserId = getUserIdFromReq(req);

  if (!currentUserId) {
    return res.status(401).json({ message: 'No se pudo identificar al usuario autenticado' });
  }

  try {
    const result = await db.query(`
      SELECT m.*, u.email as sender_email 
      FROM direct_messages m
      JOIN users u ON m.sender_id = u.id
      WHERE (m.sender_id = $1 AND m.receiver_id = $2)
         OR (m.sender_id = $2 AND m.receiver_id = $1)
      ORDER BY m.created_at ASC
    `, [currentUserId, contactId]);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al cargar mensajes' });
  }
});

router.post('/messages', async (req, res) => {
  const { receiver_id, message } = req.body;
  const sender_id = getUserIdFromReq(req);

  if (!sender_id) {
    return res.status(401).json({ message: 'Usuario no autenticado correctamente' });
  }

  if (!receiver_id || !message) {
    return res.status(400).json({ message: 'Receptor y mensaje son requeridos' });
  }

  try {
    const result = await db.query(`
      INSERT INTO direct_messages (sender_id, receiver_id, message, read)
      VALUES ($1, $2, $3, FALSE)
      RETURNING id, sender_id, receiver_id, message, read, created_at
    `, [sender_id, receiver_id, message]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al guardar el mensaje' });
  }
});

router.delete('/employee-documents/:docId', async (req, res) => {
  const { docId } = req.params;
  const { file_url } = req.query;

  try {
    let result = await db.query(
      'DELETE FROM generated_documents WHERE id = $1::uuid RETURNING *',
      [docId]
    );

    if (result.rows.length === 0 && file_url) {
      result = await db.query(
        'DELETE FROM generated_documents WHERE file_url = $1 OR file_url LIKE $2 RETURNING *',
        [file_url, `%${file_url}%`]
      );
    }

    res.json({ message: 'Documento eliminado con éxito de generated_documents' });
  } catch (error) {
    console.error('Error al eliminar documento de generated_documents:', error);
    res.status(500).json({ message: 'Error interno al eliminar el documento' });
  }
});

router.get('/employees/:employeeId/download-expediente-zip', async (req, res) => {
  const { employeeId } = req.params;
  try {
    const result = await db.query('SELECT * FROM employee_files WHERE employee_id = $1', [employeeId]);
    const files = result.rows;

    if (files.length === 0) {
      return res.status(404).json({ message: 'No hay archivos subidos en este expediente.' });
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`Expediente_Empleado_${employeeId}.zip`);

    archive.pipe(res);

    files.forEach(f => {
      const filePath = path.join(__dirname, '..', f.file_url);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: `${f.file_type}_${f.file_name}` });
      }
    });

    await archive.finalize();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al generar el archivo ZIP' });
  }
});

module.exports = router;