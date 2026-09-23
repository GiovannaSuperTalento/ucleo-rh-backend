const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// 🟢 FUNCIÓN AUXILIAR PARA NORMALIZAR Y SANEAR FOTOS O GENERAR AVATAR SVG
const processContactPhoto = (contact) => {
  const firstName = contact.first_name || "";
  const lastName = contact.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim() || contact.email || "Colaborador";
  const initials = `${firstName[0] || contact.email[0] || "C"}${lastName[0] || ""}`.toUpperCase();

  // 🎨 Generador de Avatar SVG en Base64 (Nunca falla, no requiere internet ni carpetas locales)
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#1B4B43"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="52" font-weight="bold" fill="#FFFFFF">${initials}</text></svg>`;
  const base64Svg = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString("base64")}`;

  let rawPhoto = contact.photo_url || "";

  if (typeof rawPhoto === "string") {
    rawPhoto = rawPhoto.trim();
    if (
      rawPhoto.toLowerCase().includes("null") ||
      rawPhoto.toLowerCase().includes("undefined") ||
      rawPhoto === ""
    ) {
      rawPhoto = "";
    }
  }

  // Si la ruta es local o relativa, construimos la URL completa HTTP
  if (rawPhoto && !rawPhoto.startsWith("http") && !rawPhoto.startsWith("data:")) {
    const cleanPath = rawPhoto.replace(/^public[\\/]/, "").replace(/\\/g, "/");
    rawPhoto = `http://localhost:4000/${cleanPath.startsWith("/") ? cleanPath.slice(1) : cleanPath}`;
  }

  const finalPhoto = rawPhoto || base64Svg;

  return {
    ...contact,
    full_name: fullName,
    photo_url: finalPhoto,
    avatar_url: finalPhoto,
    profile_picture: finalPhoto,
    photo: finalPhoto,
    image: finalPhoto
  };
};

// GET /api/chat/contacts -> Obtiene la lista completa de colaboradores para chatear
router.get("/contacts", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id::text AS id, u.email,
              COALESCE(e.first_name, SPLIT_PART(u.email, '@', 1)) AS first_name,
              COALESCE(e.last_name, '') AS last_name,
              COALESCE(e.position, 'Colaborador') AS position,
              COALESCE(e.department, 'General') AS department,
              e.photo_url
       FROM users u
       LEFT JOIN employees e ON LOWER(TRIM(e.personal_email)) = LOWER(TRIM(u.email))
       WHERE u.id::text != $1::text
       ORDER BY first_name ASC, u.email ASC`,
      [req.user.id]
    );

    const formattedContacts = result.rows.map(processContactPhoto);
    res.json(formattedContacts);
  } catch (err) {
    console.error("Error al obtener contactos de chat:", err.message);
    res.status(500).json({ message: "No se pudieron obtener los contactos." });
  }
});

// GET /api/chat/messages/:contactId -> Obtiene la conversación entre dos usuarios
router.get("/messages/:contactId", async (req, res) => {
  const { contactId } = req.params;
  try {
    await pool.query(
      `UPDATE messages SET is_read = true WHERE sender_id::text = $1::text AND recipient_id::text = $2::text`,
      [contactId, req.user.id]
    );

    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id::text = $1::text AND recipient_id::text = $2::text) 
          OR (sender_id::text = $2::text AND recipient_id::text = $1::text)
       ORDER BY created_at ASC`,
      [req.user.id, contactId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error al obtener mensajes:", err.message);
    res.status(500).json({ message: "Error al cargar la conversación." });
  }
});

// POST /api/chat/messages -> Enviar un mensaje
router.post("/messages", async (req, res) => {
  const { recipient_id, message } = req.body;
  if (!recipient_id || !message || !message.trim()) {
    return res.status(400).json({ message: "El destinatario y el mensaje son obligatorios." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, message, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [req.user.id, recipient_id, message.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error al enviar mensaje:", err.message);
    res.status(500).json({ message: "No se pudo enviar el mensaje." });
  }
});

// GET /api/chat/unread-count -> Contador global de mensajes no leídos
router.get("/unread-count", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM messages WHERE recipient_id::text = $1::text AND is_read = false`,
      [req.user.id]
    );
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (err) {
    console.error("Error en unread-count:", err.message);
    res.json({ count: 0 });
  }
});

module.exports = router;