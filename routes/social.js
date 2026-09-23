// routes/social.js
const express = require("express");
const pool = require("../db");
const authMiddleware = require("../middleware/auth");
const cron = require("node-cron");

const router = express.Router();

const requireAuth = authMiddleware.requireAuth;

// 🟢 MIGRACIONES AUTOMÁTICAS: Asegurar que existan la columna image_url y team_id
(async () => {
  try {
    await pool.query(`
      ALTER TABLE social_post_templates ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE social_post_templates ADD COLUMN IF NOT EXISTS team_id INTEGER;
      ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS team_id INTEGER;
      ALTER TABLE social_groups ADD COLUMN IF NOT EXISTS team_id INTEGER;
    `);
    console.log("✅ Columnas de aislamiento por equipo (team_id) e image_url verificadas/agregadas.");
  } catch (err) {
    console.warn("⚠️ Advertencia al verificar migraciones multi-tenant:", err.message);
  }
})();

// 🟢 HELPER DE PERMISOS AUTOCONTENIDO
const requirePermission = authMiddleware.requirePermission || function(permissionCode) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Usuario no autenticado." });
      }

      if (req.user.role === "admin") {
        return next();
      }

      const empRes = await pool.query(
        `SELECT position FROM employees WHERE LOWER(personal_email) = LOWER($1)`,
        [req.user.email]
      );

      if (empRes.rows.length === 0) {
        return res.status(403).json({ message: "Acceso denegado: Tu usuario no cuenta con un perfil de empleado activo." });
      }

      const userPosition = empRes.rows[0].position || "";

      const permRes = await pool.query(
        `SELECT 1 FROM position_permissions 
         WHERE (LOWER(position_name) = LOWER($1) OR LOWER(position_name) = 'todos')
         AND permission_code = $2`,
        [userPosition, permissionCode]
      );

      const isRecruiter = userPosition.toLowerCase().includes("reclutad");

      if (permRes.rows.length > 0 || isRecruiter) {
        req.user.position = userPosition;
        return next();
      }

      return res.status(403).json({ 
        message: "Acceso denegado: Tu puesto no cuenta con la autorización 'PUBLICACIONES_SOCIALES' (403 Forbidden)." 
      });
    } catch (err) {
      console.error("Error al verificar permisos de usuario:", err);
      return res.status(500).json({ message: "Error interno al validar autorización." });
    }
  };
};

// 🟢 HELPER PARA GARANTIZAR CONTEXTO DE EQUIPO (TEAM_ID)
const requireTeamContext = (req, res, next) => {
  if (!req.user || !req.user.team_id) {
    // Si la DB antigua no tiene asignado team_id aún, asignamos 1 por defecto
    req.user.team_id = req.user.team_id || 1;
  }
  next();
};

router.use(requireAuth);
router.use(requirePermission("PUBLICACIONES_SOCIALES"));
router.use(requireTeamContext);

// GET /api/social-publications/check-permission
router.get("/check-permission", (req, res) => {
  res.json({
    hasAccess: true,
    user: req.user,
    permission: "PUBLICACIONES_SOCIALES"
  });
});

// GET /api/social-publications/stats -> Métricas del Dashboard (Filtradas por Equipo)
router.get("/stats", async (req, res) => {
  try {
    const teamId = req.user.team_id;

    const statsQuery = await pool.query(`
      SELECT 
        COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE THEN 1 END) as today_posts,
        COUNT(CASE WHEN LOWER(status) = 'programada' THEN 1 END) as scheduled,
        COUNT(CASE WHEN LOWER(status) = 'publicada' THEN 1 END) as published,
        COUNT(CASE WHEN LOWER(status) = 'pendiente de aprobación' OR LOWER(status) = 'en proceso' THEN 1 END) as pending,
        COUNT(CASE WHEN LOWER(status) = 'error' THEN 1 END) as errors
      FROM social_posts
      WHERE team_id = $1 OR team_id IS NULL
    `, [teamId]);

    const groupsQuery = await pool.query(`
      SELECT COUNT(*) as active_groups FROM social_groups 
      WHERE status = 'Activo' AND (team_id = $1 OR team_id IS NULL)
    `, [teamId]);

    res.json({
      today_posts: parseInt(statsQuery.rows[0]?.today_posts || 0),
      scheduled: parseInt(statsQuery.rows[0]?.scheduled || 0),
      published: parseInt(statsQuery.rows[0]?.published || 0),
      pending: parseInt(statsQuery.rows[0]?.pending || 0),
      errors: parseInt(statsQuery.rows[0]?.errors || 0),
      active_groups: parseInt(groupsQuery.rows[0]?.active_groups || 0)
    });
  } catch (err) {
    console.error("Error al obtener estadísticas del Centro de Publicaciones:", err);
    res.json({ today_posts: 0, scheduled: 0, published: 0, pending: 0, errors: 0, active_groups: 0 });
  }
});

// GET /api/social-publications/vacancies -> Obtener vacantes de su equipo
router.get("/vacancies", async (req, res) => {
  try {
    const teamId = req.user.team_id;
    const vacanciesQuery = await pool.query(`
      SELECT e.id, e.position AS title, e.department, c.legal_name AS company_name, 
             e.street AS location, e.base_salary AS salary, e.work_schedule AS schedule,
             e.contract_type, e.job_activities AS description
      FROM employees e
      LEFT JOIN companies c ON c.id::text = e.company_id::text
      WHERE e.employment_status = 'activo' AND (e.team_id = $1 OR e.team_id IS NULL)
      LIMIT 50
    `, [teamId]);
    res.json(vacanciesQuery.rows);
  } catch (err) {
    console.error("Error al consultar vacantes:", err);
    res.json([]);
  }
});

// GET /api/social-publications/templates -> Plantillas del Equipo o Genéricas
router.get("/templates", async (req, res) => {
  try {
    const teamId = req.user.team_id;
    const templatesRes = await pool.query(`
      SELECT * FROM social_post_templates 
      WHERE team_id = $1 OR team_id IS NULL 
      ORDER BY created_at ASC
    `, [teamId]);

    if (templatesRes.rows.length === 0) {
      return res.json([
        {
          id: 1,
          name: "Vacante General",
          description: "Anuncio estándar atractivo con beneficios completos",
          content: "🧹 VACANTE: {puesto}\n\n📍 Lugar de trabajo: {ubicacion}\n\n💼 Horario:\n• {horario}\n\n💵 Sueldo: {sueldo}\n\n📄 Beneficios:\n• Prestaciones de ley desde el primer día\n• Estabilidad laboral\n\n📌 Actividades principales:\n{requisitos}\n\n📲 Si te interesa la vacante, envía mensaje por WhatsApp al {contacto}:\nhttps://wa.me/52{contacto}\n\n¡Esperamos contar contigo!"
        },
        {
          id: 2,
          name: "Vacante Urgente",
          description: "Formato enfocado en contratación inmediata",
          content: "🚨 ¡CONTRATACIÓN INMEDIATA! 🚨\n\nEstamos buscando: {puesto}\n🏢 Empresa: {empresa}\n📍 Zona: {ubicacion}\n💰 Sueldo: {sueldo}\n\nOFRECEMOS:\n• Contratación rápida\n• Pagos puntuales\n• Prestaciones de ley\n\n💬 Mándanos tu solicitud por WhatsApp al: {contacto}\n¡Comienza a trabajar esta misma semana!"
        }
      ]);
    }

    res.json(templatesRes.rows);
  } catch (err) {
    console.error("Error al cargar plantillas sociales:", err);
    res.status(500).json({ message: "Error al obtener plantillas: " + err.message });
  }
});

// POST /api/social-publications/templates -> Guardar plantilla asociada al Equipo
router.post("/templates", async (req, res) => {
  const { name, description, content, image_url } = req.body;
  const teamId = req.user.team_id;

  if (!name || !content) {
    return res.status(400).json({ message: "El nombre y contenido de la plantilla son obligatorios." });
  }

  try {
    const newTemplate = await pool.query(`
      INSERT INTO social_post_templates (name, description, content, image_url, team_id, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `, [name, description || "", content, image_url || null, teamId]);

    res.status(201).json(newTemplate.rows[0]);
  } catch (err) {
    console.error("Error al guardar plantilla social:", err);
    res.status(500).json({ message: "Error al registrar la plantilla: " + err.message });
  }
});

// GET /api/social-publications/posts -> Listar historial del Equipo
router.get("/posts", async (req, res) => {
  try {
    const teamId = req.user.team_id;
    const postsRes = await pool.query(`
      SELECT p.*, e.position AS vacancy_title, u.email AS created_by_email
      FROM social_posts p
      LEFT JOIN employees e ON e.id::text = p.vacancy_id::text
      LEFT JOIN users u ON u.id::text = p.created_by::text
      WHERE p.team_id = $1 OR p.team_id IS NULL
      ORDER BY p.created_at DESC
    `, [teamId]);
    res.json(postsRes.rows);
  } catch (err) {
    console.error("Error al obtener publicaciones:", err);
    res.status(500).json({ message: "Error al consultar publicaciones." });
  }
});

// POST /api/social-publications/posts -> Crear borrador asociado al Equipo
router.post("/posts", async (req, res) => {
  const { title, content, image_url, vacancy_id, status, scheduled_at } = req.body;
  const teamId = req.user.team_id;

  if (!title || !content) {
    return res.status(400).json({ message: "El título y el contenido del anuncio son obligatorios." });
  }

  try {
    const userId = req.user?.id ? String(req.user.id) : null;

    const newPost = await pool.query(`
      INSERT INTO social_posts (title, content, image_url, vacancy_id, status, scheduled_at, created_by, team_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING *
    `, [
      title,
      content,
      image_url || null,
      vacancy_id || null,
      status || "Borrador",
      scheduled_at || null,
      userId,
      teamId
    ]);

    try {
      await pool.query(`
        INSERT INTO social_publication_logs (post_id, user_id, user_email, user_position, action, status, message, created_at)
        VALUES ($1, $2, $3, $4, 'Creó publicación', $5, $6, NOW())
      `, [
        newPost.rows[0].id,
        userId,
        req.user?.email || "desconocido",
        req.user?.position || "Reclutador",
        newPost.rows[0].status,
        `Publicación '${title}' creada exitosamente.`
      ]);
    } catch (logErr) {
      console.warn("No se pudo escribir en el log de auditoría:", logErr.message);
    }

    res.status(201).json({
      message: "¡Publicación guardada correctamente!",
      post: newPost.rows[0]
    });
  } catch (err) {
    console.error("Error al registrar publicación:", err);
    res.status(500).json({ message: "No se pudo guardar la publicación: " + err.message });
  }
});

// GET /api/social-publications/groups -> Grupos del Equipo
router.get("/groups", async (req, res) => {
  try {
    const teamId = req.user.team_id;
    const groupsRes = await pool.query(`
      SELECT * FROM social_groups 
      WHERE team_id = $1 OR team_id IS NULL 
      ORDER BY created_at DESC
    `, [teamId]);
    res.json(groupsRes.rows);
  } catch (err) {
    console.error("Error al obtener grupos sociales:", err);
    res.status(500).json({ message: "Error al consultar grupos sociales." });
  }
});

// POST /api/social-publications/groups -> Registrar grupo para el Equipo
router.post("/groups", async (req, res) => {
  const { name, url, location, category, requires_approval, notes } = req.body;
  const teamId = req.user.team_id;

  if (!name) {
    return res.status(400).json({ message: "El nombre del grupo o canal es obligatorio." });
  }

  try {
    const userId = req.user?.id ? String(req.user.id) : null;
    const newGroup = await pool.query(`
      INSERT INTO social_groups (name, url, location, category, status, requires_approval, notes, created_by, team_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'Activo', $5, $6, $7, $8, NOW(), NOW())
      RETURNING *
    `, [
      name,
      url || null,
      location || "General",
      category || "Facebook",
      requires_approval || false,
      notes || null,
      userId,
      teamId
    ]);

    res.status(201).json({
      message: "¡Canal/Grupo registrado correctamente!",
      group: newGroup.rows[0]
    });
  } catch (err) {
    console.error("Error al registrar grupo social:", err);
    res.status(500).json({ message: "No se pudo registrar el grupo: " + err.message });
  }
});

// DELETE /api/social-publications/groups/:id
router.delete("/groups/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM social_groups WHERE id = $1 AND (team_id = $2 OR team_id IS NULL)`, [req.params.id, req.user.team_id]);
    res.json({ message: "Grupo eliminado correctamente." });
  } catch (err) {
    console.error("Error al eliminar grupo:", err);
    res.status(500).json({ message: "Error al eliminar grupo: " + err.message });
  }
});

// PUT /api/social-publications/posts/:id
router.put("/posts/:id", async (req, res) => {
  const { status, scheduled_at, title, content } = req.body;
  const postId = req.params.id;

  try {
    const userId = req.user?.id ? String(req.user.id) : null;
    const updateRes = await pool.query(`
      UPDATE social_posts
      SET status = COALESCE($1, status),
          scheduled_at = COALESCE($2, scheduled_at),
          title = COALESCE($3, title),
          content = COALESCE($4, content),
          published_at = CASE WHEN $1 = 'Publicada' THEN NOW() ELSE published_at END,
          updated_at = NOW()
      WHERE id = $5 AND (team_id = $6 OR team_id IS NULL)
      RETURNING *
    `, [status, scheduled_at || null, title, content, postId, req.user.team_id]);

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ message: "Publicación no encontrada." });
    }

    try {
      await pool.query(`
        INSERT INTO social_publication_logs (post_id, user_id, user_email, user_position, action, status, message, created_at)
        VALUES ($1, $2, $3, $4, 'Actualizó publicación', $5, $6, NOW())
      `, [
        postId,
        userId,
        req.user?.email || "desconocido",
        req.user?.position || "Reclutador",
        status || updateRes.rows[0].status,
        `Estatus cambiado a '${status}'.`
      ]);
    } catch (logErr) {
      console.warn("Error escribiendo log auditoría:", logErr.message);
    }

    res.json({ message: "Publicación actualizada correctamente.", post: updateRes.rows[0] });
  } catch (err) {
    console.error("Error al actualizar publicación:", err);
    res.status(500).json({ message: "Error al actualizar publicación: " + err.message });
  }
});

// DELETE /api/social-publications/posts/:id
router.delete("/posts/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM social_posts WHERE id = $1 AND (team_id = $2 OR team_id IS NULL)`, [req.params.id, req.user.team_id]);
    res.json({ message: "Publicación eliminada correctamente." });
  } catch (err) {
    console.error("Error al eliminar publicación:", err);
    res.status(500).json({ message: "Error al eliminar publicación." });
  }
});

// GET /api/social-publications/logs
router.get("/logs", async (req, res) => {
  try {
    const logsRes = await pool.query(`
      SELECT l.*, p.title AS post_title
      FROM social_publication_logs l
      LEFT JOIN social_posts p ON p.id = l.post_id
      WHERE p.team_id = $1 OR p.team_id IS NULL
      ORDER BY l.created_at DESC
      LIMIT 100
    `, [req.user.team_id]);
    res.json(logsRes.rows);
  } catch (err) {
    console.error("Error al consultar logs de auditoría:", err);
    res.json([]);
  }
});

// POST /api/social-publications/posts/:id/schedule
router.post("/posts/:id/schedule", async (req, res) => {
  const { scheduled_at } = req.body;
  const postId = req.params.id;

  if (!scheduled_at) {
    return res.status(400).json({ message: "Debes seleccionar una fecha y hora válidas." });
  }

  try {
    const userId = req.user?.id ? String(req.user.id) : null;

    const updateRes = await pool.query(`
      UPDATE social_posts
      SET status = 'Programada',
          scheduled_at = $1,
          updated_at = NOW()
      WHERE id = $2 AND (team_id = $3 OR team_id IS NULL)
      RETURNING *
    `, [scheduled_at, postId, req.user.team_id]);

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ message: "Publicación no encontrada." });
    }

    try {
      await pool.query(`
        INSERT INTO social_publication_logs (post_id, user_id, user_email, user_position, action, status, message, created_at)
        VALUES ($1, $2, $3, $4, 'Programó publicación', 'Programada', $5, NOW())
      `, [
        postId,
        userId,
        req.user?.email || "desconocido",
        req.user?.position || "Reclutador",
        `Publicación programada para salir el ${scheduled_at}.`
      ]);
    } catch (logErr) {
      console.warn("Error escribiendo log:", logErr.message);
    }

    res.json({ message: "¡Publicación programada con éxito!", post: updateRes.rows[0] });
  } catch (err) {
    console.error("Error al programar publicación:", err);
    res.status(500).json({ message: "Error al programar la publicación: " + err.message });
  }
});

// GET /api/social-publications/posts/:id/groups
router.get("/posts/:id/groups", async (req, res) => {
  try {
    const postGroups = await pool.query(`
      SELECT pg.*, g.name AS group_name, g.category, g.url
      FROM social_post_groups pg
      JOIN social_groups g ON g.id = pg.group_id
      WHERE pg.post_id = $1
    `, [req.params.id]);
    res.json(postGroups.rows);
  } catch (err) {
    console.error("Error al obtener grupos de la publicación:", err);
    res.json([]);
  }
});

// POST /api/social-publications/posts/:id/groups
router.post("/posts/:id/groups", async (req, res) => {
  const { group_ids } = req.body;
  const postId = req.params.id;

  if (!Array.isArray(group_ids)) {
    return res.status(400).json({ message: "Se requiere un arreglo de IDs de grupos." });
  }

  try {
    await pool.query(`DELETE FROM social_post_groups WHERE post_id = $1`, [postId]);

    for (const groupId of group_ids) {
      await pool.query(`
        INSERT INTO social_post_groups (post_id, group_id, status, created_at, updated_at)
        VALUES ($1, $2, 'Pendiente', NOW(), NOW())
      `, [postId, groupId]);
    }

    res.json({ message: "¡Grupos asignados correctamente a la publicación!" });
  } catch (err) {
    console.error("Error al asignar grupos a la publicación:", err);
    res.status(500).json({ message: "Error al asignar grupos: " + err.message });
  }
});

// 🟢 EXTENSIÓN BOT: Lee únicamente vacantes pertenecientes al Equipo activo en el Token
router.get("/extension/pending", async (req, res) => {
  try {
    const teamId = req.user.team_id;

    const pendingPosts = await pool.query(`
      SELECT p.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', g.id,
                   'name', g.name,
                   'url', g.url
                 )
               ) FILTER (WHERE g.id IS NOT NULL), '[]'
             ) AS assigned_groups
      FROM social_posts p
      LEFT JOIN social_post_groups pg ON pg.post_id = p.id
      LEFT JOIN social_groups g ON g.id = pg.group_id
      WHERE (p.team_id = $1 OR p.team_id IS NULL)
        AND (
          p.status = 'Vencida' 
          OR (p.status = 'Programada' AND (p.scheduled_at IS NULL OR p.scheduled_at <= NOW()))
        )
      GROUP BY p.id
      ORDER BY p.scheduled_at ASC, p.created_at ASC
    `, [teamId]);

    res.json(pendingPosts.rows);
  } catch (err) {
    console.error("Error al obtener pendientes para extensión:", err);
    res.status(500).json({ message: "Error al consultar cola de automatización." });
  }
});

// POST /api/social-publications/extension/complete
router.post("/extension/complete", async (req, res) => {
  const { post_id, group_id, success, error_message } = req.body;

  if (!post_id) {
    return res.status(400).json({ message: "El ID de la publicación es obligatorio." });
  }

  try {
    const userId = req.user?.id ? String(req.user.id) : null;
    const newStatus = success ? "Publicada" : "Error";

    console.log(`📡 Recibida confirmación de Extensión para Post ID: ${post_id}. Cambiando estatus a '${newStatus}'...`);

    const updateResult = await pool.query(`
      UPDATE social_posts
      SET status = $1::text,
          published_at = CASE WHEN $1::text = 'Publicada' THEN NOW() ELSE published_at END,
          updated_at = NOW()
      WHERE id::text = $2::text
      RETURNING *
    `, [newStatus, String(post_id)]);

    if (updateResult.rows.length === 0) {
      console.warn(`⚠️ No se encontró la publicación con ID: ${post_id} para actualizar estatus.`);
      return res.status(404).json({ message: "Publicación no encontrada en la base de datos." });
    }

    try {
      await pool.query(`
        INSERT INTO social_publication_logs (post_id, group_id, user_id, user_email, user_position, action, status, message, created_at)
        VALUES ($1::integer, $2, $3, $4, $5, 'Automatización de Extensión', $6, $7, NOW())
      `, [
        isNaN(Number(post_id)) ? null : Number(post_id),
        group_id || null,
        userId,
        req.user?.email || "Extension Bot",
        req.user?.position || "Reclutador",
        newStatus,
        success ? "Publicación enviada exitosamente a Facebook por la extensión." : `Error de envío: ${error_message}`
      ]);
    } catch (logErr) {
      console.warn("⚠️ No se pudo escribir el log de auditoría (no crítico):", logErr.message);
    }

    res.json({ message: "Estado de automatización actualizado correctamente.", post: updateResult.rows[0] });
  } catch (err) {
    console.error("❌ Error al actualizar estado desde extensión:", err);
    res.status(500).json({ message: "Error interno al registrar confirmación: " + err.message });
  }
});

// 🟢 CRON JOB EN BACKEND (Cada 5 minutos)
cron.schedule("*/5 * * * *", async () => {
  try {
    await pool.query(`
      UPDATE social_posts
      SET status = 'Programada', updated_at = NOW()
      WHERE status = 'En Proceso' AND updated_at < NOW() - INTERVAL '10 minutes'
    `);

    const expiredResult = await pool.query(`
      UPDATE social_posts
      SET status = 'Vencida', updated_at = NOW()
      WHERE status = 'Programada' 
        AND scheduled_at IS NOT NULL 
        AND scheduled_at < NOW() - INTERVAL '10 minutes'
      RETURNING id, title
    `);

    if (expiredResult.rowCount > 0) {
      console.log(`[CRON SOCIAL] Se marcaron ${expiredResult.rowCount} publicaciones vencidas.`);
      for (const post of expiredResult.rows) {
        await pool.query(`
          INSERT INTO social_publication_logs (post_id, action, status, message, created_at)
          VALUES ($1, 'Revisión Servidor', 'Vencida', 'La publicación superó su hora programada sin ejecución por extensión.', NOW())
        `, [post.id]);
      }
    }
  } catch (err) {
    console.error("[CRON SOCIAL ERROR]", err);
  }
});

module.exports = router;