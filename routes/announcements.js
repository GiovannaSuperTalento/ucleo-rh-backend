// routes/announcements.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

// ---------------------------------------------------------------
// AUTO-MIGRACIÓN DE TABLA ANNOUNCEMENTS
// ---------------------------------------------------------------
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'General',
        team_id INTEGER DEFAULT 1,
        author_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'General';
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS team_id INTEGER DEFAULT 1;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS author_id INTEGER;
    `);
    console.log("✅ Tabla 'announcements' verificada/creada correctamente.");
  } catch (err) {
    console.warn("⚠️ Advertencia en migración de announcements:", err.message);
  }
})();

// ---------------------------------------------------------------
// GET /api/announcements -> Obtener todos los comunicados
// ---------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM announcements ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error al obtener anuncios:", err.message);
    res.status(500).json({ message: "Error al cargar comunicados." });
  }
});

// ---------------------------------------------------------------
// POST /api/announcements -> Crear un nuevo comunicado
// ---------------------------------------------------------------
router.post("/", requireAuth, async (req, res) => {
  const { title, content, category, team_id } = req.body;

  if (!title || !content) {
    return res.status(400).json({ message: "El título y el contenido son obligatorios." });
  }

  try {
    const authorId = req.user ? req.user.id : null;
    const teamId = team_id || (req.user ? req.user.team_id : 1);

    const result = await pool.query(
      `INSERT INTO announcements (title, content, category, team_id, author_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [title, content, category || "General", teamId, authorId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error al crear anuncio:", err.message);
    res.status(500).json({ message: "Error al publicar comunicado." });
  }
});

// ---------------------------------------------------------------
// DELETE /api/announcements/:id -> Eliminar un comunicado
// ---------------------------------------------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query("DELETE FROM announcements WHERE id = $1 RETURNING id", [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Comunicado no encontrado." });
    }

    res.json({ message: "Comunicado eliminado correctamente." });
  } catch (err) {
    console.error("Error al eliminar anuncio:", err.message);
    res.status(500).json({ message: "Error al eliminar comunicado." });
  }
});

module.exports = router;
