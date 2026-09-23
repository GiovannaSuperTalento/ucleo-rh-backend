const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Todas las rutas del Dashboard requieren autenticación
router.use(requireAuth);

// GET /api/dashboard/stats
router.get("/stats", async (req, res) => {
  try {
    const [
      employeesResult,
      vacanciesResult,
      leaveRequestsResult,
      incidentsResult,
    ] = await Promise.all([
      // Empleados activos
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM employees
        WHERE employment_status = 'activo'
      `),

      // Vacantes abiertas
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM job_openings
        WHERE status = 'open'
      `),

      // Solicitudes pendientes
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM leave_requests
        WHERE status = 'pendiente'
      `),

      // Incidencias registradas durante el mes actual
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM incidents
        WHERE created_at >= date_trunc('month', CURRENT_DATE)
          AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      `),
    ]);

    res.json({
      employees: employeesResult.rows[0].total,
      vacancies: vacanciesResult.rows[0].total,
      leaveRequests: leaveRequestsResult.rows[0].total,
      incidents: incidentsResult.rows[0].total,
    });
  } catch (err) {
    console.error(
      "Error obteniendo estadísticas del Dashboard:",
      err
    );

    res.status(500).json({
      message: "No se pudieron obtener las estadísticas del Dashboard.",
    });
  }
});

module.exports = router;