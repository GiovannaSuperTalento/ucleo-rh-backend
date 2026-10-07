const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { extractCvText } = require("../utils/atsCvAnalysis");
const { analyzeCv } = require("../utils/atsAiAnalysis");
const { generateAssessment } = require("../utils/atsAssessmentGenerator");
const { generateAssessmentWithAI } = require("../utils/atsAssessmentAi");
const { sendAssessmentInvitation } = require("../utils/atsAssessmentMailer");

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
const cvPreviewUpload = multer({
  storage: multer.memoryStorage(),
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

function handleCvPreviewUpload(req, res, next) {
  cvPreviewUpload.single("cv")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "El CV no puede superar 10 MB."
      : err.message || "No se pudo leer el CV.";
    res.status(400).json({ message });
  });
}

async function removeStoredCv(storedName) {
  if (!storedName) return;
  const filePath = path.join(cvDirectory, path.basename(storedName));
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
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

function getAssessmentToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function publicAssessmentQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map(({ id, category, type, prompt, options, points }) => ({
    id, category, type, prompt, options, points,
  }));
}

function completedPublicQuestions(questions, answers, manualReviews = []) {
  const answerMap = new Map((Array.isArray(answers) ? answers : []).map((answer) => [answer.questionId, answer]));
  const reviewMap = new Map((Array.isArray(manualReviews) ? manualReviews : []).map((review) => [review.questionId, review]));
  return (Array.isArray(questions) ? questions : []).map((question) => {
    const answer = answerMap.get(question.id) || null;
    const review = reviewMap.get(question.id) || null;
    const correctOption = question.type === "single_choice"
      ? (question.options || []).find((option) => option.id === question.correctOptionId)
      : null;
    return {
      ...publicAssessmentQuestions([question])[0],
      answer,
      isCorrect: question.type === "single_choice" ? answer?.selectedOptionId === question.correctOptionId : null,
      correctAnswer: correctOption?.text || null,
      manualReview: review ? { score: review.score } : null,
    };
  });
}

function normalizeAssessmentQuestions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 60) {
    throw Object.assign(new Error("La prueba debe tener entre 1 y 60 preguntas."), { status: 400 });
  }
  const ids = new Set();
  return input.map((raw) => {
    const id = String(raw?.id || crypto.randomUUID()).slice(0, 80);
    const category = String(raw?.category || "General").trim().slice(0, 120);
    const type = String(raw?.type || "");
    const prompt = String(raw?.prompt || "").trim().slice(0, 3000);
    if (!id || ids.has(id) || !category || !prompt || !["written", "single_choice"].includes(type)) {
      throw Object.assign(new Error("Revisa que cada pregunta tenga categoría, texto y un tipo válido."), { status: 400 });
    }
    ids.add(id);
    if (type === "written") {
      return { id, category, type, prompt, rubric: String(raw?.rubric || "").trim().slice(0, 2000), points: 0 };
    }
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 8) {
      throw Object.assign(new Error("Cada pregunta de opción múltiple debe incluir entre 2 y 8 opciones."), { status: 400 });
    }
    const options = raw.options.map((option, index) => ({
      id: String(option?.id || String.fromCharCode(97 + index)).slice(0, 20),
      text: String(option?.text || "").trim().slice(0, 500),
    }));
    if (options.some((option) => !option.id || !option.text) || new Set(options.map((option) => option.id)).size !== options.length) {
      throw Object.assign(new Error("Completa todas las opciones y asegúrate de que sean distintas."), { status: 400 });
    }
    const correctOptionId = String(raw.correctOptionId || "");
    if (!options.some((option) => option.id === correctOptionId)) {
      throw Object.assign(new Error("Selecciona la respuesta correcta de cada pregunta objetiva."), { status: 400 });
    }
    return { id, category, type, prompt, options, correctOptionId, points: Math.max(1, Math.min(10, Number(raw.points) || 1)) };
  });
}

async function findAssessmentByToken(token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await pool.query(
    `SELECT a.id, a.application_id, a.title, a.questions, a.answers, a.manual_review,
            a.status, a.expires_at, a.auto_score, a.max_auto_score,
            a.manual_score, a.max_manual_score, a.submitted_at,
            c.first_name, v.title AS vacancy_title
     FROM ats_assessments a
     JOIN ats_applications ap ON ap.id = a.application_id
     JOIN ats_candidates c ON c.id = ap.candidate_id
     JOIN ats_vacancies v ON v.id = ap.vacancy_id
     WHERE a.token_hash = $1 LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

// Enlace con token aleatorio de un solo uso; no requiere cuenta del candidato.
router.get("/public/assessment", async (req, res) => {
  const token = getAssessmentToken(req);
  try {
    const assessment = await findAssessmentByToken(token);
    if (!assessment) return res.status(404).json({ message: "El enlace de evaluación no es válido." });
    if (assessment.status === "completed") {
      res.set("Cache-Control", "no-store");
      return res.json({
        completed: true,
        title: assessment.title,
        vacancyTitle: assessment.vacancy_title,
        candidateName: assessment.first_name,
        score: assessment.auto_score,
        maxScore: assessment.max_auto_score,
        manualScore: assessment.manual_score,
        maxManualScore: assessment.max_manual_score,
        questions: completedPublicQuestions(assessment.questions, assessment.answers, assessment.manual_review),
      });
    }
    if (assessment.status !== "sent" || !assessment.expires_at || new Date(assessment.expires_at) <= new Date()) {
      return res.status(410).json({ message: "El enlace venció o ya no está disponible. Comunícate con reclutamiento." });
    }
    res.set("Cache-Control", "no-store");
    res.json({
      completed: false,
      title: assessment.title,
      vacancyTitle: assessment.vacancy_title,
      candidateName: assessment.first_name,
      expiresAt: assessment.expires_at,
      questions: publicAssessmentQuestions(assessment.questions),
    });
  } catch (err) {
    console.error("Error al abrir evaluación ATS pública:", err.message);
    res.status(500).json({ message: "No se pudo abrir la evaluación." });
  }
});

router.post("/public/assessment/submit", async (req, res) => {
  const token = getAssessmentToken(req);
  const submittedAnswers = Array.isArray(req.body?.answers) ? req.body.answers : null;
  if (!submittedAnswers || submittedAnswers.length > 60) {
    return res.status(400).json({ message: "Las respuestas no tienen un formato válido." });
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT a.id, a.application_id, a.questions
       FROM ats_assessments a
       WHERE a.token_hash = $1 AND a.status = 'sent' AND a.expires_at > NOW()
       FOR UPDATE`,
      [tokenHash]
    );
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(410).json({ message: "El enlace venció o la evaluación ya fue enviada." });
    }
    const assessment = result.rows[0];
    const questions = Array.isArray(assessment.questions) ? assessment.questions : [];
    const answerMap = new Map(submittedAnswers.map((item) => [String(item?.questionId || ""), item]));
    if (!questions.length || questions.some((question) => !answerMap.has(question.id))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Responde todas las preguntas antes de enviar." });
    }

    const answers = questions.map((question) => {
      const input = answerMap.get(question.id);
      if (question.type === "single_choice") {
        const selectedOptionId = String(input?.selectedOptionId || "");
        if (!question.options?.some((option) => option.id === selectedOptionId)) {
          throw Object.assign(new Error("Selecciona una opción válida para cada pregunta."), { status: 400 });
        }
        return { questionId: question.id, selectedOptionId };
      }
      const text = String(input?.text || "").trim().slice(0, 3000);
      if (text.length < 5) throw Object.assign(new Error("Escribe una respuesta breve para cada pregunta abierta."), { status: 400 });
      return { questionId: question.id, text };
    });
    const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const autoScore = questions.reduce((score, question) => {
      if (question.type !== "single_choice") return score;
      return score + (answerByQuestion.get(question.id)?.selectedOptionId === question.correctOptionId ? question.points : 0);
    }, 0);
    const maxAutoScore = questions.reduce((score, question) => score + (question.type === "single_choice" ? question.points : 0), 0);
    await client.query(
      `UPDATE ats_assessments
       SET answers = $2, auto_score = $3, max_auto_score = $4,
           status = 'completed', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [assessment.id, JSON.stringify(answers), autoScore, maxAutoScore]
    );
    await client.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'evaluacion', 'El candidato completó la evaluación enviada por correo.', 'Candidato')`,
      [assessment.application_id]
    );
    await client.query("COMMIT");
    res.json({
      message: "Tus respuestas se enviaron correctamente.",
      completed: true,
      score: autoScore,
      maxScore: maxAutoScore,
      manualScore: null,
      maxManualScore: questions.filter((question) => question.type === "written").length * 8,
      questions: completedPublicQuestions(questions, answers),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.status === 400) return res.status(400).json({ message: err.message });
    console.error("Error al enviar respuestas ATS:", err.message);
    res.status(500).json({ message: "No se pudieron enviar las respuestas." });
  } finally {
    client.release();
  }
});

router.use(requireAuth, requireRecruitmentAccess);

router.post("/vacancies/:id/cv-preview", handleCvPreviewUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Selecciona un CV para analizar." });

  try {
    const vacancyResult = await pool.query(
      `SELECT id, title, description, responsibilities, requirements, assessment_focus,
              soft_skills_focus, excel_level, english_level
       FROM ats_vacancies WHERE id::text = $1`,
      [req.params.id]
    );
    if (!vacancyResult.rows.length) return res.status(404).json({ message: "No se encontró la vacante." });

    const text = await extractCvText(req.file.buffer, req.file.originalname);
    const analysis = await analyzeCv({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      vacancyId: vacancyResult.rows[0].id,
      vacancy: vacancyResult.rows[0],
      requirements: vacancyResult.rows[0].requirements,
      text,
    });
    res.json(analysis);
  } catch (err) {
    console.error("Error al analizar CV ATS:", err.message);
    res.status(422).json({ message: "No se pudo leer el CV automáticamente. Puedes capturar los datos manualmente y adjuntar el archivo." });
  }
});

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
  const { title, company_id, department, location, employment_type, description, responsibilities, requirements, assessment_focus, excel_level, english_level, soft_skills_focus } = req.body;
  if (!String(title || "").trim()) return res.status(400).json({ message: "El título de la vacante es obligatorio." });

  try {
    const result = await pool.query(
      `INSERT INTO ats_vacancies
        (title, company_id, department, location, employment_type, description, responsibilities, requirements,
         assessment_focus, excel_level, english_level, soft_skills_focus, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [String(title).trim(), company_id || null, department || null, location || null,
        employment_type || null, description || null, responsibilities || null, requirements || null,
        assessment_focus || null, excel_level || null, english_level || null, soft_skills_focus || null,
        req.user?.email || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error al crear vacante ATS:", err.message);
    res.status(500).json({ message: "No se pudo crear la vacante." });
  }
});

router.put("/vacancies/:id", async (req, res) => {
  const { title, company_id, department, location, employment_type, description, responsibilities, requirements, assessment_focus, excel_level, english_level, soft_skills_focus, status } = req.body;
  if (!String(title || "").trim()) return res.status(400).json({ message: "El título de la vacante es obligatorio." });
  if (status && !allowedVacancyStatuses.includes(status)) {
    return res.status(400).json({ message: "El estado de la vacante no es válido." });
  }

  try {
    const result = await pool.query(
      `UPDATE ats_vacancies SET
         title = $2, company_id = $3, department = $4, location = $5,
         employment_type = $6, description = $7, responsibilities = $8, requirements = $9,
         assessment_focus = $10, excel_level = $11, english_level = $12,
         soft_skills_focus = $13, status = COALESCE($14, status), updated_at = NOW()
       WHERE id::text = $1
       RETURNING *`,
      [req.params.id, String(title).trim(), company_id || null, department || null,
        location || null, employment_type || null, description || null, responsibilities || null, requirements || null,
        assessment_focus || null, excel_level || null, english_level || null, soft_skills_focus || null, status || null]
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
  const searchTerms = search.split(/\s+/).filter(Boolean);
  try {
    const result = await pool.query(`
      SELECT a.id, a.vacancy_id, a.candidate_id, a.stage, a.source, a.cv_storage_name, a.cv_analysis,
             a.cv_original_name, a.applied_at, a.updated_at,
             c.first_name, c.last_name, c.email, c.phone,
             v.title AS vacancy_title, v.company_id, co.legal_name AS company_name
      FROM ats_applications a
      JOIN ats_candidates c ON c.id = a.candidate_id
      JOIN ats_vacancies v ON v.id = a.vacancy_id
      LEFT JOIN companies co ON co.id::text = v.company_id
      WHERE ($1::text = '' OR a.vacancy_id::text = $1)
        AND ($2::text = '' OR CONCAT_WS(' ', c.first_name, c.last_name, c.email, c.phone, a.source) ILIKE $3
          OR NOT EXISTS (
            SELECT 1 FROM UNNEST($4::text[]) AS search_term(value)
            WHERE CONCAT_WS(' ', c.first_name, c.last_name, c.email, c.phone, a.source)
              NOT ILIKE '%' || search_term.value || '%'
          ))
      ORDER BY a.updated_at DESC, a.applied_at DESC
    `, [vacancyId, search, `%${search}%`, searchTerms]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error al consultar candidatos ATS:", err.message);
    res.status(500).json({ message: "No se pudieron cargar los candidatos." });
  }
});

router.get("/applications/:id/assessments", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, application_id, assessment_type, title, questions, answers, status,
              expires_at, sent_at, submitted_at, auto_score, max_auto_score,
              manual_review, manual_score, max_manual_score, created_at, updated_at
       FROM ats_assessments WHERE application_id::text = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error al consultar pruebas ATS:", err.message);
    res.status(500).json({ message: "No se pudieron consultar las pruebas." });
  }
});

router.post("/applications/:id/assessments/draft", async (req, res) => {
  const assessmentType = String(req.body?.type || "");
  const allowedTypes = new Set(["completa", "puesto", "excel", "ingles", "habilidades_blandas"]);
  if (!allowedTypes.has(assessmentType)) return res.status(400).json({ message: "Selecciona un tipo de prueba válido." });
  try {
    const target = await pool.query(
      `SELECT ap.id AS application_id, v.title, v.department, v.location, v.employment_type,
              v.description, v.responsibilities, v.requirements,
              v.assessment_focus, v.excel_level, v.english_level, v.soft_skills_focus
       FROM ats_applications ap
       JOIN ats_vacancies v ON v.id = ap.vacancy_id
       WHERE ap.id::text = $1`,
      [req.params.id]
    );
    if (!target.rows.length) return res.status(404).json({ message: "No se encontró la postulación." });
    const generated = ["puesto", "completa", "habilidades_blandas"].includes(assessmentType)
      ? await generateAssessmentWithAI(target.rows[0], assessmentType)
      : generateAssessment(target.rows[0], assessmentType);
    if (!generated.questions.length) {
      const messages = {
        puesto: "Agrega descripción, responsabilidades o requisitos a la vacante para generar esta prueba.",
        excel: "Configura un nivel de Excel en la vacante antes de generar su prueba.",
        ingles: "Configura un nivel de inglés en la vacante antes de generar su prueba.",
        habilidades_blandas: "Configura habilidades blandas en la vacante antes de generar esta prueba.",
      };
      return res.status(422).json({ message: messages[assessmentType] || "No hay información suficiente para generar la prueba." });
    }
    const saved = await pool.query(
      `INSERT INTO ats_assessments (application_id, assessment_type, title, questions, status, max_auto_score, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)
       RETURNING id, application_id, assessment_type, title, questions, status, max_auto_score, created_at, updated_at`,
      [target.rows[0].application_id, assessmentType, generated.title, JSON.stringify(generated.questions), generated.maxAutoScore, req.user?.email || null]
    );
    await pool.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'evaluacion', $2, $3)`,
      [target.rows[0].application_id,
        `Se generó el borrador “${generated.title}” con ${generated.questions.length} preguntas${generated.provider === "local" ? ` mediante el generador local de respaldo${generated.fallbackReason ? ` (${generated.fallbackReason})` : ""}` : generated.provider ? ` mediante IA ${generated.provider}` : ""}.`,
        req.user?.email || null]
    );
    res.status(201).json({ ...saved.rows[0], generationProvider: generated.provider || null, generationNote: generated.fallbackReason || null });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    if (err.publicMessage) return res.status(err.status || 502).json({ message: err.message });
    console.error("Error al generar borrador de prueba ATS:", err.message);
    res.status(500).json({ message: "No se pudo generar el borrador de la prueba." });
  }
});

router.patch("/assessments/:id/draft", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim().slice(0, 255);
    if (!title) return res.status(400).json({ message: "Escribe un título para la prueba." });
    const questions = normalizeAssessmentQuestions(req.body?.questions);
    const maxAutoScore = questions.filter((question) => question.type === "single_choice")
      .reduce((sum, question) => sum + question.points, 0);
    const saved = await pool.query(
      `UPDATE ats_assessments
       SET title = $2, questions = $3, max_auto_score = $4, updated_at = NOW()
       WHERE id::text = $1 AND status = 'draft'
       RETURNING id, application_id, assessment_type, title, questions, status,
                 max_auto_score, created_at, updated_at`,
      [req.params.id, title, JSON.stringify(questions), maxAutoScore]
    );
    if (!saved.rows.length) return res.status(409).json({ message: "Solo se pueden editar pruebas que aún están en borrador." });
    res.json(saved.rows[0]);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    console.error("Error al guardar borrador de prueba ATS:", err.message);
    res.status(500).json({ message: "No se pudo guardar la prueba." });
  }
});

router.get("/applications/:id/assessment", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, application_id, title, questions, answers, status, expires_at,
              sent_at, submitted_at, auto_score, max_auto_score,
              manual_review, manual_score, max_manual_score, created_at
       FROM ats_assessments WHERE application_id::text = $1
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("Error al consultar evaluación ATS:", err.message);
    res.status(500).json({ message: "No se pudo consultar la evaluación." });
  }
});

router.patch("/assessments/:id/manual-review", async (req, res) => {
  const reviews = Array.isArray(req.body?.reviews) ? req.body.reviews : null;
  if (!reviews || reviews.length > 30) return res.status(400).json({ message: "La revisión no tiene un formato válido." });
  try {
    const found = await pool.query(
      "SELECT id, application_id, questions, status FROM ats_assessments WHERE id::text = $1",
      [req.params.id]
    );
    if (!found.rows.length) return res.status(404).json({ message: "No se encontró la evaluación." });
    const assessment = found.rows[0];
    if (assessment.status !== "completed") return res.status(409).json({ message: "La revisión manual estará disponible cuando el candidato envíe sus respuestas." });
    const written = (assessment.questions || []).filter((question) => question.type === "written");
    const incoming = new Map(reviews.map((review) => [String(review?.questionId || ""), review]));
    if (written.some((question) => !incoming.has(question.id))) {
      return res.status(400).json({ message: "Completa la revisión de todas las respuestas abiertas." });
    }
    const savedReviews = written.map((question) => {
      const review = incoming.get(question.id);
      const score = Number(review?.score);
      if (!Number.isInteger(score) || score < 0 || score > 8) {
        throw Object.assign(new Error("Cada respuesta abierta debe recibir una puntuación entera de 0 a 8."), { status: 400 });
      }
      return { questionId: question.id, score, notes: String(review?.notes || "").trim().slice(0, 1000) };
    });
    const manualScore = savedReviews.reduce((sum, review) => sum + review.score, 0);
    const maxManualScore = written.length * 8;
    await pool.query(
      `UPDATE ats_assessments
       SET manual_review = $2, manual_score = $3, max_manual_score = $4, updated_at = NOW()
       WHERE id = $1`,
      [assessment.id, JSON.stringify(savedReviews), manualScore, maxManualScore]
    );
    await pool.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'evaluacion', $2, $3)`,
      [assessment.application_id, `Se guardó la revisión manual de respuestas abiertas (${manualScore}/${maxManualScore}).`, req.user?.email || null]
    );
    res.json({ manual_review: savedReviews, manual_score: manualScore, max_manual_score: maxManualScore });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    console.error("Error al guardar revisión manual ATS:", err.message);
    res.status(500).json({ message: "No se pudo guardar la revisión manual." });
  }
});

router.post("/assessments/:id/send", async (req, res) => {
  let mailSent = false;
  let claimedAssessmentId = null;
  try {
    const found = await pool.query(
      `SELECT a.id, a.application_id, a.title, a.questions, a.assessment_type,
              c.first_name, c.last_name, c.email, v.title AS vacancy_title
       FROM ats_assessments a
       JOIN ats_applications ap ON ap.id = a.application_id
       JOIN ats_candidates c ON c.id = ap.candidate_id
       JOIN ats_vacancies v ON v.id = ap.vacancy_id
       WHERE a.id::text = $1 AND a.status = 'draft'`,
      [req.params.id]
    );
    if (!found.rows.length) return res.status(409).json({ message: "No se encontró el borrador o ya no se puede enviar." });
    const assessment = found.rows[0];
    const questions = normalizeAssessmentQuestions(assessment.questions);
    const configuredFrontend = process.env.FRONTEND_URL;
    if (!configuredFrontend && process.env.NODE_ENV === "production") {
      throw new Error("Configura FRONTEND_URL con la dirección pública de Vercel antes de enviar evaluaciones.");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const linkUrl = new URL("/", configuredFrontend || "http://localhost:5173");
    linkUrl.hash = `evaluacion=${token}`;
    const durationMinutes = Math.min(90, Math.max(10, questions.length * 4));
    const claimed = await pool.query(
      `UPDATE ats_assessments
       SET status = 'sending', token_hash = $2, expires_at = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'draft'
       RETURNING id`,
      [assessment.id, tokenHash, expiresAt]
    );
    if (!claimed.rows.length) return res.status(409).json({ message: "El borrador ya está siendo enviado o cambió. Actualiza la lista de pruebas." });
    claimedAssessmentId = assessment.id;
    await sendAssessmentInvitation({
      to: assessment.email,
      candidateName: `${assessment.first_name} ${assessment.last_name}`,
      vacancyTitle: assessment.vacancy_title,
      assessmentTitle: assessment.title,
      link: linkUrl.toString(),
      expiresAt,
      durationMinutes,
      questionCount: questions.length,
    });
    mailSent = true;

    const sent = await pool.query(
      `UPDATE ats_assessments
       SET status = 'sent', sent_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'sending'
       RETURNING id, application_id, assessment_type, title, questions, status,
                 expires_at, sent_at, max_auto_score, created_at, updated_at`,
      [assessment.id]
    );
    if (!sent.rows.length) return res.status(409).json({ message: "El borrador cambió antes de poder enviarse. Comprueba el historial de pruebas." });
    await pool.query(
      `UPDATE ats_assessments SET status = 'expired', token_hash = NULL, updated_at = NOW()
       WHERE application_id = $1 AND id <> $2 AND assessment_type = $3 AND status = 'sent'`,
      [assessment.application_id, assessment.id, assessment.assessment_type]
    );
    await pool.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'evaluacion', $2, $3)`,
      [assessment.application_id, `Se envió por correo “${assessment.title}” (${questions.length} preguntas). El enlace vence en 7 días.`, req.user?.email || null]
    );
    res.json({ ...sent.rows[0], recipient: assessment.email });
  } catch (err) {
    if (claimedAssessmentId && !mailSent) {
      await pool.query(
        `UPDATE ats_assessments SET status = 'draft', token_hash = NULL, expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'sending'`,
        [claimedAssessmentId]
      ).catch(() => {});
    } else if (claimedAssessmentId && mailSent) {
      await pool.query(
        `UPDATE ats_assessments SET status = 'sent', sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
         WHERE id = $1 AND status = 'sending'`,
        [claimedAssessmentId]
      ).catch(() => {});
    }
    console.error("Error al enviar borrador de prueba ATS:", err.message);
    res.status(mailSent ? 201 : 502).json({ message: mailSent
      ? "El correo se envió, pero no se pudo actualizar el seguimiento. Actualiza el expediente antes de volver a enviar para evitar duplicados."
      : err.publicMessage || err.message.includes("EMAIL_USER") || err.message.includes("SMTP_USER") || err.message.includes("FRONTEND_URL")
        ? err.message
        : "No se pudo enviar la prueba. Revisa la configuración de correo del backend." });
  }
});

router.post("/applications/:id/assessment/send", async (req, res) => {
  let assessmentId = null;
  let tokenHash = null;
  let emailSent = false;
  try {
    const target = await pool.query(
      `SELECT ap.id AS application_id, c.first_name, c.last_name, c.email,
              v.title, v.description, v.responsibilities, v.requirements,
              v.assessment_focus, v.excel_level, v.english_level, v.soft_skills_focus
       FROM ats_applications ap
       JOIN ats_candidates c ON c.id = ap.candidate_id
       JOIN ats_vacancies v ON v.id = ap.vacancy_id
       WHERE ap.id::text = $1`,
      [req.params.id]
    );
    if (!target.rows.length) return res.status(404).json({ message: "No se encontró la postulación." });
    const candidate = target.rows[0];
    const generated = generateAssessment(candidate);
    if (!generated.questions.length) return res.status(422).json({ message: "Completa actividades o requisitos de la vacante para generar una evaluación." });

    const token = crypto.randomBytes(32).toString("base64url");
    tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const saved = await pool.query(
      `INSERT INTO ats_assessments
         (application_id, title, questions, token_hash, status, expires_at, sent_at, max_auto_score, created_by)
       VALUES ($1, $2, $3, $4, 'sent', $5, NOW(), $6, $7)
       RETURNING id`,
      [candidate.application_id, generated.title, JSON.stringify(generated.questions), tokenHash,
        expiresAt, generated.maxAutoScore, req.user?.email || null]
    );
    assessmentId = saved.rows[0].id;

    const configuredFrontend = process.env.FRONTEND_URL;
    if (!configuredFrontend && process.env.NODE_ENV === "production") {
      throw new Error("Configura FRONTEND_URL con la dirección pública de Vercel antes de enviar evaluaciones.");
    }
    const linkUrl = new URL("/", configuredFrontend || "http://localhost:5173");
    linkUrl.hash = `evaluacion=${token}`;
    await sendAssessmentInvitation({
      to: candidate.email,
      candidateName: `${candidate.first_name} ${candidate.last_name}`,
      vacancyTitle: candidate.title,
      assessmentTitle: generated.title,
      link: linkUrl.toString(),
      expiresAt,
      durationMinutes: generated.durationMinutes,
      questionCount: generated.questions.length,
    });
    emailSent = true;
    await pool.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       VALUES ($1, 'evaluacion', $2, $3)`,
      [candidate.application_id,
        `Se envió por correo una evaluación de ${generated.questions.length} preguntas. El enlace vence en 7 días.`,
        req.user?.email || null]
    );
    res.status(201).json({
      id: assessmentId,
      title: generated.title,
      questionCount: generated.questions.length,
      durationMinutes: generated.durationMinutes,
      maxAutoScore: generated.maxAutoScore,
      autoReviewCount: generated.autoReviewCount,
      status: "sent",
      expires_at: expiresAt,
      recipient: candidate.email,
    });
  } catch (err) {
    if (assessmentId && !emailSent) {
      await pool.query(
        `UPDATE ats_assessments SET status = 'delivery_failed', token_hash = NULL, updated_at = NOW() WHERE id = $1`,
        [assessmentId]
      ).catch(() => {});
    }
    console.error("Error al generar/enviar evaluación ATS:", err.message);
    if (emailSent) {
      return res.status(201).json({ message: "La evaluación se envió, pero no se pudo registrar en el seguimiento." });
    }
    res.status(502).json({ message: err.publicMessage || err.message.includes("EMAIL_USER") || err.message.includes("SMTP_USER") || err.message.includes("FRONTEND_URL")
      ? err.message
      : "No se pudo enviar la evaluación. Revisa la configuración de correo del backend." });
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
      `SELECT id, status, title, description, responsibilities, requirements,
              assessment_focus, soft_skills_focus, excel_level, english_level
       FROM ats_vacancies WHERE id::text = $1`,
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

    let cvAnalysis = null;
    if (req.file) {
      try {
        const buffer = await fs.promises.readFile(req.file.path);
        const cvText = await extractCvText(buffer, req.file.originalname);
        const analysis = await analyzeCv({
          buffer,
          filename: req.file.originalname,
          vacancyId: vacancy.rows[0].id,
          vacancy: vacancy.rows[0],
          requirements: vacancy.rows[0].requirements,
          text: cvText,
        });
        // Keep manually confirmed form data; AI values are used by preview,
        // and the persisted assessment remains associated with this CV.
        cvAnalysis = analysis.assessment;
      } catch (analysisError) {
        console.warn("No se pudo extraer texto para la evaluación ATS:", analysisError.message);
        cvAnalysis = {
          available: false,
          reason: "No se pudo leer el CV automáticamente. Revisa el archivo manualmente.",
          matched: [],
          notFound: [],
          note: "La falta de texto detectable no indica que la persona carezca de experiencia.",
        };
      }
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
        (vacancy_id, candidate_id, stage, source, cv_storage_name, cv_original_name, cv_analysis)
       VALUES ($1, $2, 'recibido', $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, candidate.rows[0].id, req.body.source || "Registro manual",
        req.file?.filename || null, req.file?.originalname || null, cvAnalysis]
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

router.delete("/applications/:id/cv", async (req, res) => {
  const client = await pool.connect();
  let storedName = null;
  try {
    await client.query("BEGIN");
    const application = await client.query(
      "SELECT cv_storage_name FROM ats_applications WHERE id::text = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!application.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No se encontró la postulación." });
    }
    storedName = application.rows[0].cv_storage_name;
    if (!storedName) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Esta postulación no tiene un CV adjunto." });
    }
    await removeStoredCv(storedName);

    await client.query(
      `UPDATE ats_applications
       SET cv_storage_name = NULL, cv_original_name = NULL, cv_analysis = NULL, updated_at = NOW()
       WHERE id::text = $1`,
      [req.params.id]
    );
    await client.query(
      `INSERT INTO ats_application_activity (application_id, activity_type, content, created_by)
       SELECT id, 'documento', 'Se eliminó el CV adjunto y su evaluación automática.', $2
       FROM ats_applications WHERE id::text = $1`,
      [req.params.id, req.user?.email || null]
    );
    await client.query("COMMIT");
    res.json({ message: "Se eliminó el CV y su evaluación. El seguimiento del candidato se conservó." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error al eliminar CV ATS:", err.message);
    res.status(500).json({ message: "No se pudo eliminar el CV." });
  } finally {
    client.release();
  }
});

router.delete("/applications/:id", async (req, res) => {
  const client = await pool.connect();
  let storedName = null;
  try {
    await client.query("BEGIN");
    const application = await client.query(
      `SELECT id, candidate_id, cv_storage_name
       FROM ats_applications WHERE id::text = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!application.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No se encontró la postulación." });
    }

    const { id, candidate_id: candidateId } = application.rows[0];
    storedName = application.rows[0].cv_storage_name;
    await removeStoredCv(storedName);
    await client.query("DELETE FROM ats_applications WHERE id = $1", [id]);
    await client.query(
      `DELETE FROM ats_candidates c
       WHERE c.id = $1
         AND NOT EXISTS (SELECT 1 FROM ats_applications a WHERE a.candidate_id = c.id)`,
      [candidateId]
    );
    await client.query("COMMIT");
    res.json({ message: "Se eliminó la postulación y su seguimiento de esta vacante." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error al eliminar postulación ATS:", err.message);
    res.status(500).json({ message: "No se pudo eliminar la postulación." });
  } finally {
    client.release();
  }
});

module.exports = router;
