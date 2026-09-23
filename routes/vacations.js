const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// Helper para obtener empleado por correo
const getEmployeeByEmail = async (email) => {
  const userEmail = String(email).trim().toLowerCase();
  const result = await pool.query(
    `SELECT id, hire_date, first_name, last_name, department 
     FROM employees 
     WHERE LOWER(personal_email) = $1`,
    [userEmail]
  );
  return result.rows[0] || null;
};

// 1. Manejo de saldo de vacaciones
const handleBalance = async (req, res) => {
  try {
    const userEmail = req.user ? String(req.user.email).trim().toLowerCase() : "";
    const employee = await getEmployeeByEmail(userEmail);

    if (!employee) {
      return res.json({
        yearsOfService: 0,
        totalEntitledDays: 12,
        totalDays: 12,
        usedDays: 0,
        remainingDays: 12
      });
    }

    const hireDate = new Date(employee.hire_date || new Date());
    const yearsOfService = Math.max(0, Math.floor((new Date() - hireDate) / (365.25 * 24 * 60 * 60 * 1000)));

    let totalEntitledDays = 12;
    if (yearsOfService > 1) {
      totalEntitledDays = 12 + (Math.min(yearsOfService, 5) - 1) * 2;
      if (yearsOfService > 5) {
        totalEntitledDays += Math.floor((yearsOfService - 5) / 5) * 2;
      }
    }

    const usedResult = await pool.query(
      `SELECT COALESCE(SUM(days_requested), 0) AS used_days
       FROM vacation_requests
       WHERE employee_id = $1 AND status = 'aprobado'`,
      [employee.id]
    );

    const usedDays = parseInt(usedResult.rows[0].used_days, 10);
    const remainingDays = Math.max(0, totalEntitledDays - usedDays);

    res.json({
      yearsOfService,
      totalEntitledDays,
      totalDays: totalEntitledDays,
      usedDays,
      remainingDays
    });
  } catch (err) {
    console.error("Error al calcular saldo de vacaciones:", err);
    res.status(500).json({ message: "Error al calcular saldo de vacaciones." });
  }
};

router.get("/summary", handleBalance);
router.get("/my-balance", handleBalance);

// 2. Obtener solicitudes del usuario
const handleMyRequests = async (req, res) => {
  try {
    const userEmail = req.user ? String(req.user.email).trim().toLowerCase() : "";
    const employee = await getEmployeeByEmail(userEmail);

    if (!employee) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT vr.*, e.first_name, e.last_name 
       FROM vacation_requests vr
       JOIN employees e ON e.id = vr.employee_id
       WHERE vr.employee_id = $1
       ORDER BY vr.created_at DESC`,
      [employee.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error al obtener solicitudes:", err);
    res.status(500).json({ message: "Error al cargar tus solicitudes." });
  }
};

router.get("/my-requests", handleMyRequests);
router.get("/requests", handleMyRequests);

// 3. Calendario departamental
router.get("/department-calendar", async (req, res) => {
  try {
    const userEmail = req.user ? String(req.user.email).trim().toLowerCase() : "";
    const employee = await getEmployeeByEmail(userEmail);

    if (!employee || !employee.department) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT vr.id, vr.start_date, vr.end_date, vr.request_type, e.first_name, e.last_name, e.department
       FROM vacation_requests vr
       JOIN employees e ON e.id = vr.employee_id
       WHERE e.department = $1 AND vr.status = 'aprobado'`,
      [employee.department]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error al obtener calendario departamental:", err);
    res.status(500).json({ message: "Error al cargar el calendario departamental." });
  }
});

// 4. Crear nueva solicitud
router.post("/request", async (req, res) => {
  const { start_date, end_date, request_type, comments, days_requested } = req.body;

  try {
    const userEmail = req.user ? String(req.user.email).trim().toLowerCase() : "";
    const employee = await getEmployeeByEmail(userEmail);

    if (!employee) {
      return res.status(404).json({ message: "Empleado no encontrado." });
    }

    const newRequest = await pool.query(
      `INSERT INTO vacation_requests (employee_id, start_date, end_date, request_type, comments, days_requested, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendiente') RETURNING *`,
      [
        employee.id,
        start_date,
        end_date,
        request_type || "vacaciones",
        comments || "",
        days_requested || 1
      ]
    );

    res.status(201).json(newRequest.rows[0]);
  } catch (err) {
    console.error("Error al registrar solicitud:", err);
    res.status(500).json({ message: "No se pudo registrar la solicitud." });
  }
});

// 5. Revisar solicitud (Aprobar/Rechazar)
router.put("/requests/:id/review", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE vacation_requests SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error al revisar solicitud:", err);
    res.status(500).json({ message: "Error al actualizar la solicitud." });
  }
});

// 
module.exports = router;