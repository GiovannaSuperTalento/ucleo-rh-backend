const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const cvDirectory = process.env.ATS_CV_DIRECTORY
  ? path.resolve(process.env.ATS_CV_DIRECTORY)
  : path.join(__dirname, "..", "private-uploads", "ats-cv");
fs.mkdirSync(cvDirectory, { recursive: true });

const allowedStages = ["recibido", "revision", "entrevista", "evaluacion", "oferta", "contratado", "descartado"];
const allowedVacancyStatuses = ["abierta", "pausada", "cerrada"];
const fileExtensions = new Set([".pdf", ".doc", ".docx"]);

const cvUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, cvDirectory),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!fileExtensions.has(extension)) {
      return callback(new Error("El CV debe estar en formato PDF, DOC o DOCX."));
    }
    callback(null, true);
  },
});

function handleCvUpload(req, res, next) {
  cvUpload.single("cv")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "El CV no puede superar 10 MB."
      : err.message || "No se pudo cargar el CV.";
    res.status(400).json({ message });
  });
}

async function requireRecruitmentAccess(req, res, next) {
  if (req.user?.role === "admin" || req.user?.role === "administrator") return next();

  try {
    const employeeResult = await pool.query(
      "SELECT position FROM employees WHERE LOWER(personal_email) = LOWER($1) LIMIT 1",
      [req.user?.email || ""]
    );
    if (employeeResult.rows.length === 0) {
      return res.status(403).json({ message: "No tienes permiso para acceder al módulo de reclutamiento." });
    }

    const position = employeeResult.rows[0].position || "";
    if (/reclutad|\brh\b|recursos\s+humanos|talento/i.test(position)) {
      req.user.position = position;
      return next();
    }

    const permissionResult = await pool.query(
      `SELECT 1 FROM position_permissions
       WHERE (LOWER(position_name) = LOWER($1) OR LOWER(position_name) = 'todos')
         AND permission_code = 'PUBLICACIONES_SOCIALES'
       LIMIT 1`,
      [position]
    );

    if (permissionResult.rows.length > 0) {
      req.user.position = position;
      return next();
    }
    return res.status(403).json({ message: "No tienes permiso para acceder al módulo de reclutamiento." });
  } catch (err) {
    console.error("Error al validar acceso al ATS:", err.message);
    return res.status(500).json({ message: "No se pudo validar el acceso al módulo de reclutamiento." });
  }
}

router.use(requireAuth, requireRecruitmentAccess);

router.get("/vacancies", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, c.legal_name AS company_name,
             COUNT(a.id)::int AS total_applications,
             COUNT(a.id) FILTER (WHERE a.stage NOT IN ('contratado', 'descartado'))::int AS active_applications
      FROM ats_vacancies v
      LEFT JOIN companies c ON c.id::text = v.company_id
      LEFT JOIN ats_applications a ON a.vacancy_id = v.id
      GROUP BY v.id, c.legal_name
      ORDER BY CASE v.status WHEN 'abierta' THEN 0 WHEN 'pausada' THEN 1 ELSE 2 END,
               v.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error al consultar vacantes ATS:", err.message);
    res.status(500).json({ message: "No se pudieron cargar las vacantes." });
  }
});

router.post("/vacancies", async (req, res) => {
  const { title, company_id, department, location, employment_type, description, requirements } = req.body;
  if (!String(title || "").trim()) return res.status(400).json({ message: "El título de la vacante es obligatorio." });

  try {
    const result = await pool.query(
      `INSERT INTO ats_vacancies
        (title, company_id, department, location, employment_type, description, requirements, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [String(title).trim(), company_id || null, department || null, location || null,
        employment_type || null, description || null, requirements || null, req.user?.email || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error al crear vacante ATS:", err.message);
    res.status(500).json({ message: "No se pudo crear la vacante." });
  }
});

router.put("/vacancies/:id", async (req, res) => {
  const { title, company_id, department, location, employment_type, description, requirements, status } = req.body;
  if (!String(title || "").trim()) return res.status(400).json({ message: "El título de la vacante es obligatorio." });
  if (status && !allowedVacancyStatuses.includes(status)) {
    return res.status(400).json({ message: "El estado de la vacante no es válido." });
  }

  try {
    const result = await pool.query(
      `UPDATE ats_vacancies SET
         title = $2, company_id = $3, department = $4, location = $5,
         employment_type = $6, description = $7, requirements = $8,
         status = COALESCE($9, status), updated_at = NOW()
       WHERE id::text = $1
       RETURNING *`,
      [req.params.id, String(title).trim(), company_id || null, department || null,
        location || null, employment_type || null, description || null, requirements || null, status || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "No se encontró la vacante." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error al actualizar vacante ATS:", err.message);
    res.status(500).json({ message: "No se pudo actualizar la vacante." });
  }
});

router.get("/applications", async (req, res) => {
  const vacancyId = typeof req.query.vacancy_id === "string" ? req.query.vacancy_id : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  try {
    const result = await pool.query(`
      SELECT a.id, a.vacancy_id, a.candidate_id, a.stage, a.source, a.cv_storage_name,
             a.cv_original_name, a.applied_at, a.updated_at,
             c.first_name, c.last_name, c.email, c.phone,
             v.title AS vacancy_title, v.company_id, co.legal_name AS company_name
      FROM ats_applications a
      JOIN ats_candidates c ON c.id = a.candidate_id
      JOIN ats_vacancies v ON v.id = a.vacancy_id
      LEFT JOIN companies co ON co.id::text = v.company_id
      WHERE ($1::text = '' OR a.vacancy_id::text = $1)
        AND ($2::text = '' OR CONCAT_WS(' ', c.first_name, c.last_name, c.email, c.phone, a.source) ILIKE $3)
      ORDER BY a.updated_at DESC, a.applied_at DESC
    `, [vacancyId, search, `%${search}%`]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error al consultar candidatos ATS:", err.message);
    res.status(500).json({ message: "No se pudieron cargar los candidatos." });
  }
});

router.post("/vacancies/:id/applications", handleCvUpload, async (req, res) => {
  const firstName = String(req.body.first_name || "").trim();
  const lastName = String(req.body.last_name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!firstName || !lastName || !email) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: "Nombre, apellido y correo son obligatorios." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const vacancy = await client.query(
      "SELECT id, status FROM ats_vacancies WHERE id::text = $1",
      [req.params.id]
    );
    if (!vacancy.rows.length) {
      await client.query("ROLLBACK");
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ message: "No se encontró la vacante." });
    }
    if (vacancy.rows[0].status !== "abierta") {
      await client.query("ROLLBACK");
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(409).json({ message: "Solo puedes agregar candidatos a una vacante abierta." });
    }

    const candidate = await client.query(
      `INSERT INTO ats_candidates (first_name, last_name, email, email_normalized, phone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email_normalized) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         phone = COALESCE(EXCLUDED.phone, ats_candidates.phone),
         updated_at = NOW()
       RETURNING id`,
      [firstName, lastName, email, email, req.body.phone || null]
    );

    const application = await client.query(
      `INSERT INTO ats_applications
        (vacancy_id, candidate_id, stage, source, cv_storage_name, cv_original_name)
       VALUES ($1, $2, 'recibido', $3, $4, $5)
       RETURNING *`,
      [req.params.id, candidate.rows[0].id, req.body.source || "Registro manual",
        req.file?.filename || null, req.file?.originalname || null]
    );

    await client.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'postulacion', 'Candidato agregado a la vacante.', $2)`,
      [application.rows[0].id, req.user?.email || null]
    );
    await client.query("COMMIT");
    res.status(201).json(application.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (req.file) fs.unlink(req.file.path, () => {});
    if (err.code === "23505") {
      return res.status(409).json({ message: "Este candidato ya está registrado para esa vacante." });
    }
    console.error("Error al registrar candidato ATS:", err.message);
    res.status(500).json({ message: "No se pudo registrar al candidato." });
  } finally {
    client.release();
  }
});

router.patch("/applications/:id/stage", async (req, res) => {
  const { stage } = req.body;
  if (!allowedStages.includes(stage)) return res.status(400).json({ message: "La etapa indicada no es válida." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE ats_applications SET stage = $2, updated_at = NOW()
       WHERE id::text = $1 RETURNING id, stage`,
      [req.params.id, stage]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No se encontró la postulación." });
    }
    await client.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'etapa', $2, $3)`,
      [result.rows[0].id, `Etapa actualizada a: ${stage}.`, req.user?.email || null]
    );
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error al cambiar etapa ATS:", err.message);
    res.status(500).json({ message: "No se pudo cambiar la etapa del candidato." });
  } finally {
    client.release();
  }
});

router.get("/applications/:id/activities", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, activity_type, content, created_by, created_at
       FROM ats_application_activity WHERE application_id::text = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error al consultar actividad ATS:", err.message);
    res.status(500).json({ message: "No se pudo cargar el historial del candidato." });
  }
});

router.post("/applications/:id/activities", async (req, res) => {
  const content = String(req.body.content || "").trim();
  if (!content) return res.status(400).json({ message: "Escribe una nota antes de guardarla." });
  try {
    const result = await pool.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       SELECT id, 'nota', $2, $3 FROM ats_applications WHERE id::text = $1
       RETURNING id, activity_type, content, created_by, created_at`,
      [req.params.id, content, req.user?.email || null]
    );
    if (!result.rows.length) return res.status(404).json({ message: "No se encontró la postulación." });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error al guardar nota ATS:", err.message);
    res.status(500).json({ message: "No se pudo guardar la nota." });
  }
});

router.get("/applications/:id/cv", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT cv_storage_name, cv_original_name FROM ats_applications WHERE id::text = $1",
      [req.params.id]
    );
    const storedName = result.rows[0]?.cv_storage_name;
    if (!storedName) return res.status(404).json({ message: "Esta postulación no tiene un CV adjunto." });
    const filePath = path.join(cvDirectory, path.basename(storedName));
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "No se encontró el archivo de CV." });
    res.download(filePath, result.rows[0].cv_original_name || "CV-candidato");
  } catch (err) {
    console.error("Error al descargar CV ATS:", err.message);
    res.status(500).json({ message: "No se pudo descargar el CV." });
  }
});

module.exports = router;
