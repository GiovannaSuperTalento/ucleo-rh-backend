const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/announcements -> Obtener todos los avisos
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM announcements ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error al obtener comunicados." });
  }
});

// POST /api/announcements -> Crear aviso (Solo admin)
router.post("/", requireRole("admin"), async (req, res) => {
  const { title, content, priority } = req.body;
  if (!title || !content) {
    return res.status(400).json({ message: "El título y contenido son obligatorios." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, content, priority)
       VALUES ($1, $2, $3) RETURNING *`,
      [title, content, priority || "normal"]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error al publicar comunicado." });
  }
});

// DELETE /api/announcements/:id -> Eliminar aviso (Solo admin)
router.delete("/:id", requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM announcements WHERE id = $1 RETURNING id", [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: "Aviso no encontrado." });
    res.json({ message: "Comunicado eliminado correctamente." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error al eliminar comunicado." });
  }
});

module.exports = router;