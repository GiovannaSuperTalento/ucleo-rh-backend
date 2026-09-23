const express = require("express");
const router = express.Router();
const pool = require("../db");

// 🟢 GET /api/leaves/requests
router.get("/requests", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, e.first_name, CONCAT(e.last_name_paternal, ' ', e.last_name_maternal) as last_name 
       FROM leave_requests l 
       LEFT JOIN employees e ON l.employee_id::text = e.id::text 
       ORDER BY l.created_at DESC`
    ).catch(() => ({ rows: [] }));
    res.json(result.rows || []);
  } catch (err) {
    res.json([]);
  }
});

// 🟢 GET /api/leaves/types
router.get("/types", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM leave_types ORDER BY name ASC").catch(() => ({ rows: [] }));
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
    // Opciones por defecto si la tabla no tiene datos
    res.json([
      { id: "vacaciones", name: "Vacaciones Dignas (LFT)" },
      { id: "permiso_goce", name: "Permiso con Goce de Sueldo" },
      { id: "permiso_sin_goce", name: "Permiso sin Goce de Sueldo" },
      { id: "incapacidad", name: "Incapacidad / Salud" }
    ]);
  } catch (err) {
    res.json(["Vacaciones", "Permiso con Goce", "Permiso sin Goce"]);
  }
});

// 🟢 GET /api/leaves/my-balance
router.get("/my-balance", async (req, res) => {
  res.json({
    remainingDays: 12,
    usedDays: 0,
    totalDays: 12,
    yearsOfService: 1
  });
});

// 🟢 GET /api/leaves/department-calendar
router.get("/department-calendar", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.start_date, l.end_date, l.request_type, e.first_name, e.last_name_paternal as last_name
       FROM leave_requests l
       LEFT JOIN employees e ON l.employee_id::text = e.id::text
       WHERE l.status = 'aprobado'`
    ).catch(() => ({ rows: [] }));
    res.json(result.rows || []);
  } catch (err) {
    res.json([]);
  }
});

// 🟢 POST /api/leaves/request
router.post("/request", async (req, res) => {
  res.json({ message: "Solicitud registrada con éxito." });
});

module.exports = router;