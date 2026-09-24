// 1. IMPORTACIONES
const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db");
const aiAssistantRouter = require("./routes/aiAssistant");
const documentsRouter = require("./routes/documents");
const companiesRouter = require("./routes/companies");
const employeesRouter = require("./routes/employees"); // 🟢 IMPORTACIÓN DEL ROUTER DE EMPLEADOS
const announcementsRouter = require("./routes/announcements"); // 🟢 IMPORTACIÓN DEL ROUTER DE COMUNICADOS
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "nucleo_rh_secret_key_2026";
const nodemailer = require("nodemailer");

// 2. INICIALIZACIÓN DE EXPRESS
const app = express();

const transporter = nodemailer.createTransport({
  service: "gmail", // Puedes cambiarlo por tu servidor SMTP
  auth: {
    user: process.env.EMAIL_USER || "tu_correo@gmail.com",
    pass: process.env.EMAIL_PASS || "tu_contraseña_de_aplicacion"
  }
});

// 3. MIDDLEWARES
app.use(cors());

// 🟢 PERMITIR PAYLOADS DE HASTA 50MB (Soporte para imágenes en Base64)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/generated-docs", express.static(path.join(__dirname, "generated-docs")));

app.use("/api/social-publications", require("./routes/social"));
// RUTA PARA EL ASISTENTE VIRTUAL (NúcleoBot)
app.use("/api", aiAssistantRouter);

// Router de empresas
app.use("/api/companies", companiesRouter);

// 🟢 ENRUTADOR DE EMPLEADOS COMPLETO
app.use("/api/employees", employeesRouter);

// 🟢 ENRUTADOR DE COMUNICADOS Y ANUNCIOS
app.use("/api/announcements", announcementsRouter);

// Adaptador para estandarizar los datos del frontend antes de pasar al router de documentos
app.use("/api/documents/generate", (req, res, next) => {
  if (req.method === "POST" && req.body) {
    req.body.employee_id = req.body.employee_id || req.body.employeeId || req.body.id;
    req.body.template_id = req.body.template_id || req.body.template || req.body.documentType || req.body.type;
  }
  next();
});

// Vinculación directa con tu módulo de documentos
app.use("/api/documents", documentsRouter);

// ============================================================================
// 🟢 RUTAS ADICIONALES PARA PLANTILLAS Y OPCIONES MULTI-FORMATO
// ============================================================================
app.get("/api/templates/multi-form-options", (req, res) => {
  res.json([
    "Vacaciones",
    "Permiso con Goce",
    "Permiso sin Goce",
    "Cambio de Cuenta Bancaria",
    "Constancia de Trabajo",
    "Incapacidad / Salud"
  ]);
});

// ============================================================================
// 🟢 ENDPOINTS DE VACACIONES Y PERMISOS (TABLA: leave_requests)
// ============================================================================
app.get("/api/leaves/requests", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lr.*, e.first_name, e.last_name, e.department 
       FROM leave_requests lr 
       LEFT JOIN employees e ON e.id::text = lr.employee_id::text 
       ORDER BY lr.created_at DESC`
    ).catch(async () => {
      return await pool.query("SELECT * FROM leave_requests ORDER BY created_at DESC");
    });
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener solicitudes de permiso:", err.message);
    res.json([]);
  }
});

app.get("/api/leaves/types", (req, res) => {
  res.json([
    { id: "vacaciones", name: "Vacaciones Dignas" },
    { id: "permiso_goce", name: "Permiso con Goce de Sueldo" },
    { id: "permiso_sin_goce", name: "Permiso sin Goce de Sueldo" },
    { id: "incapacidad", name: "Incapacidad Médica IMSS" }
  ]);
});

app.get("/api/leaves/my-balance", async (req, res) => {
  res.json({
    totalDays: 12,
    usedDays: 0,
    remainingDays: 12,
    yearsOfService: 1
  });
});

app.get("/api/leaves/department-calendar", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lr.*, e.first_name, e.last_name, e.department 
       FROM leave_requests lr 
       JOIN employees e ON e.id::text = lr.employee_id::text 
       WHERE lr.status = 'aprobado'`
    ).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

app.post("/api/leaves/requests", async (req, res) => {
  const { employee_id, leave_type_id, start_date, end_date, comments } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO leave_requests (employee_id, request_type, start_date, end_date, status, comments, created_at)
       VALUES ($1, $2, $3, $4, 'pendiente', $5, NOW()) RETURNING *`,
      [employee_id || null, leave_type_id || "Vacaciones", start_date, end_date, comments || ""]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error al solicitar permiso:", err.message);
    res.status(500).json({ message: "No se pudo registrar la solicitud." });
  }
});

app.put("/api/leaves/requests/:id/review", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE leave_requests SET status = $1 WHERE id::text = $2::text RETURNING *`,
      [status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Error al actualizar estado del permiso." });
  }
});

// Endpoint contador para evitar errores 404 en la consola del chat
app.get("/api/chat/unread-count", (req, res) => {
  res.json({ count: 0, unreadCount: 0 });
});

// ============================================================================
// 🟢 HELPER PARA DETECTAR DINÁMICAMENTE LA COLUMNA DE PASSWORD EN USERS
// ============================================================================
const getPasswordColumnName = async () => {
  try {
    const colResult = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
    );
    const cols = colResult.rows.map(r => r.column_name.toLowerCase());

    if (cols.includes("password")) return "password";
    if (cols.includes("password_hash")) return "password_hash";
    if (cols.includes("pass")) return "pass";
    return "password";
  } catch (err) {
    return "password";
  }
};

// ============================================================================
// 🟢 MAPEADOR AUXILIAR RESILIENTE CON AVATAR EN BASE64
// ============================================================================
const mapEmployeeData = (emp) => {
  if (!emp) return null;
 
  const firstName = emp.first_name || "";
  const lastName = emp.last_name || "";
  const fullName = emp.full_name || `${firstName} ${lastName}`.trim() || "Colaborador";

  const initials = `${firstName[0] || ""}${lastName[0] || ""}`.toUpperCase() || "RH";

  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#1B4B43"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="52" font-weight="bold" fill="#FFFFFF">${initials}</text></svg>`;
  const base64Svg = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString("base64")}`;

  let rawPhoto = emp.photo_url || emp.avatar_url || emp.profile_picture || emp.photo || emp.image || "";

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

  if (rawPhoto && !rawPhoto.startsWith("http") && !rawPhoto.startsWith("data:")) {
    const cleanPath = rawPhoto.replace(/^public[\\/]/, "").replace(/\\/g, "/");
    rawPhoto = `http://localhost:4000/${cleanPath.startsWith("/") ? cleanPath.slice(1) : cleanPath}`;
  }

  const finalPhoto = rawPhoto || base64Svg;

  return {
    ...emp,
    id: String(emp.id),
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    photo_url: finalPhoto,
    avatar_url: finalPhoto,
    profile_picture: finalPhoto,
    photo: finalPhoto,
    image: finalPhoto,
    document_id: emp.document_id || emp.curp || emp.nss || emp.dni || emp.id,
    hire_date: emp.hire_date || emp.start_date || emp.created_at,
    salary: emp.salary || emp.wage || 0,
    email: emp.email || "",
    phone: emp.phone || emp.mobile || ""
  };
};

app.get("/api/organigram", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM employees");
    const formatted = result.rows.map(mapEmployeeData);
    res.json(formatted);
  } catch (err) {
    console.error("❌ Error en organigrama:", err.message);
    res.json([]);
  }
});

// ============================================================================
// 🟢 ENDPOINTS DE NOTAS Y POST-ITS (TABLA: tasks)
// ============================================================================
app.get("/api/notes", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, description, priority, color, due_date, created_at FROM tasks ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al consultar notas:", err.message);
    res.json([]);
  }
});

app.post("/api/notes", async (req, res) => {
  const { title, description, color, priority, due_date } = req.body;
  try {
    const defaultColumnId = "11111111-1111-1111-1111-111111111111";
    const result = await pool.query(
      `INSERT INTO tasks (title, description, color, priority, column_id, due_date, created_at)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, NOW())
       RETURNING *`,
      [
        title || "Nueva Nota",
        description || "",
        color || "#FEF08A",
        priority || "media",
        defaultColumnId,
        due_date || null
      ]
    );
    console.log("✅ NOTA GUARDADA EN POSTGRESQL:", result.rows[0].title);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ ERROR AL GUARDAR NOTA:", err.message);
    res.status(500).json({ error: "Error al guardar nota.", details: err.message });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM tasks WHERE id = $1::uuid", [id]);
    console.log(`🗑️ Nota con ID ${id} eliminada de PostgreSQL`);
    res.json({ message: "Nota eliminada exitosamente." });
  } catch (err) {
    console.error("❌ Error al eliminar nota:", err.message);
    res.status(500).json({ error: "Error al eliminar nota." });
  }
});

// ============================================================================
// 🟢 ENDPOINTS DE CALENDARIO (TABLA: leave_requests)
// ============================================================================
app.get("/api/calendar-events", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, request_type, start_date, end_date, status, created_at FROM leave_requests ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al consultar eventos:", err.message);
    res.json([]);
  }
});

app.post("/api/calendar-events", async (req, res) => {
  const { title, start_date, end_date, request_type, status } = req.body;
  try {
    const eventType = title || request_type || "Evento General";
    const startDateVal = start_date || new Date();
    const endDateVal = end_date || startDateVal;
    const statusVal = status || "aprobado";

    const result = await pool.query(
      `INSERT INTO leave_requests (request_type, start_date, end_date, status, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [eventType, startDateVal, endDateVal, statusVal]
    );
    console.log("✅ EVENTO REGISTRADO EN POSTGRESQL:", result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error al guardar evento:", err.message);
    res.status(500).json({ error: "Error al agendar evento." });
  }
});

// ============================================================================
// 🟢 ENDPOINTS DE MENSAJERÍA Y CHAT ENTRE COLABORADORES
// ============================================================================

app.get(["/api/chat/users", "/api/chat/contacts"], async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM employees ORDER BY first_name ASC");
    const contacts = result.rows.map(mapEmployeeData);
    res.json(contacts);
  } catch (err) {
    console.error("❌ Error al obtener contactos para el chat:", err.message);
    res.status(500).json([]);
  }
});

app.get("/api/chat/messages", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM chat_messages
       WHERE receiver_id::text = 'general' OR sender_id::text = 'general'
       ORDER BY created_at ASC`
    ).catch(() => ({ rows: [] }));

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al consultar historial general de chat:", err.message);
    res.json([]);
  }
});

app.get("/api/chat/messages/:receiverId", async (req, res) => {
  const { receiverId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM chat_messages
       WHERE receiver_id::text = $1::text OR sender_id::text = $1::text
       ORDER BY created_at ASC`,
      [receiverId]
    ).catch(() => ({ rows: [] }));

    res.json(result.rows);
  } catch (err) {
    console.error(`❌ Error al consultar chat con usuario ${receiverId}:`, err.message);
    res.json([]);
  }
});

app.post("/api/chat/messages", async (req, res) => {
  const { sender_id, receiver_id, message, text } = req.body;
  const content = message || text || "";

  try {
    const result = await pool.query(
      `INSERT INTO chat_messages (sender_id, receiver_id, message, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [sender_id || "sistema", receiver_id || "general", content]
    ).catch(async () => {
      return {
        rows: [{
          id: Date.now(),
          sender_id: sender_id || "sistema",
          receiver_id: receiver_id || "general",
          message: content,
          created_at: new Date()
        }]
      };
    });

    console.log("💬 Mensaje enviado exitosamente:", content);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error al enviar mensaje:", err.message);
    res.status(500).json({ error: "Error al enviar el mensaje." });
  }
});

// ============================================================================
// 🟢 SISTEMA DEFINITIVO DE REGISTRO Y GESTIÓN DE USUARIOS
// ============================================================================

const handleRegisterUser = async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Correo y contraseña son obligatorios." });
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    const passCol = await getPasswordColumnName();
    
    const existing = await pool.query("SELECT id FROM users WHERE LOWER(TRIM(email)) = $1", [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Ya existe un usuario registrado con este correo." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userRole = role || "empleado";

    const query = `INSERT INTO users (email, ${passCol}, role, is_active, created_at)
                   VALUES ($1, $2, $3, true, NOW()) RETURNING id::text, email, role, is_active`;
    const result = await pool.query(query, [cleanEmail, hashedPassword, userRole]);

    console.log("✅ Usuario registrado exitosamente:", cleanEmail);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error en registro de usuario:", err.message);
    res.status(500).json({ message: "Error interno al crear usuario." });
  }
};

app.post(["/api/users", "/api/register", "/api/auth/register"], handleRegisterUser);

app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id::text, email, role, is_active, created_at FROM users ORDER BY email ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al consultar usuarios:", err.message);
    res.status(500).json([]);
  }
});

app.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { role, is_active, password } = req.body;

  try {
    const passCol = await getPasswordColumnName();
    let query = "UPDATE users SET role = COALESCE($1, role), is_active = COALESCE($2, is_active)";
    let params = [role, is_active];

    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      query += `, ${passCol} = $3 WHERE id::text = $4::text RETURNING id::text, email, role, is_active`;
      params.push(hashedPassword, id);
    } else {
      query += " WHERE id::text = $3::text RETURNING id::text, email, role, is_active";
      params.push(id);
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(`❌ Error al actualizar usuario ${id}:`, err.message);
    res.status(500).json({ message: "No se pudo actualizar el usuario." });
  }
});

app.delete("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM users WHERE id::text = $1::text", [id]);
    res.json({ message: "Usuario eliminado exitosamente." });
  } catch (err) {
    console.error(`❌ Error al eliminar usuario ${id}:`, err.message);
    res.status(500).json({ message: "Error al eliminar usuario." });
  }
});

// ============================================================================
// 🟢 ENDPOINTS DE AUTENTICACIÓN Y LOGIN (RESILIENTE CON COLUMNA DINÁMICA)
// ============================================================================

const handleLogin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Correo y contraseña obligatorios." });
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    const passCol = await getPasswordColumnName();

    const result = await pool.query(
      `SELECT id, email, role, is_active, ${passCol} AS user_password FROM users WHERE LOWER(TRIM(email)) = $1`,
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Credenciales inválidas." });
    }

    const user = result.rows[0];

    if (user.is_active === false) {
      return res.status(403).json({ message: "Esta cuenta se encuentra inactiva." });
    }

    const userPass = user.user_password || "";
    let validPassword = false;

    if (userPass.startsWith("$2a$") || userPass.startsWith("$2b$")) {
      validPassword = await bcrypt.compare(password, userPass);
    } else {
      validPassword = userPass === password;
    }

    if (!validPassword) {
      return res.status(401).json({ message: "Credenciales inválidas." });
    }

    const tokenPayload = { id: String(user.id), email: user.email, role: user.role };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "7d" });

    res.json({
      token,
      user: {
        id: String(user.id),
        email: user.email,
        role: user.role,
        is_active: user.is_active
      }
    });
  } catch (err) {
    console.error("❌ Error en autenticación:", err.message);
    res.status(500).json({ message: "Error interno al procesar el inicio de sesión." });
  }
};

app.post("/api/auth/login", handleLogin);
app.post("/api/login", handleLogin);

app.get(["/api/auth/me", "/api/me"], async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token no proporcionado." });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      "SELECT id::text, email, role, is_active FROM users WHERE id::text = $1::text",
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(401).json({ message: "Token inválido o expirado." });
  }
});

// ============================================================================
// 🟢 RECUPERACIÓN Y CAMBIO DE CONTRASEÑA VÍA EMAIL / CONSOLA
// ============================================================================

app.post(["/api/auth/forgot-password", "/api/forgot-password"], async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "El correo es obligatorio." });

  try {
    const result = await pool.query(
      "SELECT id, email FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No existe una cuenta registrada con este correo." });
    }

    const user = result.rows[0];
    const resetToken = jwt.sign({ id: user.id, purpose: "reset_password" }, JWT_SECRET, { expiresIn: "15m" });
    const resetLink = `http://localhost:5173/?resetToken=${resetToken}`;

    const mailOptions = {
      from: '"Núcleo RH" <no-reply@nucleorh.com>',
      to: user.email,
      subject: "Restablecimiento de Contraseña - Núcleo RH",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 25px; color: #1B2A2E; max-width: 500px; border: 1px solid #E2E8F0; border-radius: 12px; margin: 0 auto;">
          <h2 style="color: #1B4B43; margin-top: 0;">Restablecer Contraseña</h2>
          <p>Hola,</p>
          <p>Has solicitado restablecer tu contraseña para acceder al portal <strong>Núcleo RH</strong>.</p>
          <p>Haz clic en el siguiente botón para continuar (el enlace vencerá en 15 minutos):</p>
          <div style="margin: 25px 0; text-align: center;">
            <a href="${resetLink}" style="background-color: #1B4B43; color: #FFFFFF; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              Restablecer mi Contraseña
            </a>
          </div>
          <p style="font-size: 11px; color: #64748B;">Si no solicitaste este cambio, puedes ignorar este correo de forma segura.</p>
        </div>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`📧 Correo de recuperación enviado a: ${user.email}`);
    } catch (mailErr) {
      console.warn("⚠️ No se pudo enviar por SMTP. LINK DE RECUPERACIÓN EN CONSOLA:", resetLink);
    }

    res.json({
      message: "Se ha enviado un enlace de recuperación a tu correo electrónico. Revisa tu bandeja de entrada o la carpeta de Spam."
    });
  } catch (err) {
    console.error("❌ Error al procesar recuperación:", err.message);
    res.status(500).json({ message: "No se pudo procesar la solicitud de recuperación." });
  }
});

app.post(["/api/auth/reset-password", "/api/reset-password"], async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ message: "El token y la nueva contraseña son obligatorios." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== "reset_password") {
      return res.status(400).json({ message: "Token no válido para restablecer contraseña." });
    }

    const passCol = await getPasswordColumnName();
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE users SET ${passCol} = $1 WHERE id::text = $2::text`,
      [hashedPassword, decoded.id]
    );

    console.log(`✅ Contraseña actualizada exitosamente para usuario ID: ${decoded.id}`);
    res.json({ message: "Contraseña actualizada exitosamente. Ya puedes iniciar sesión." });
  } catch (err) {
    console.error("❌ Error al restablecer contraseña:", err.message);
    res.status(400).json({ message: "El enlace de recuperación es inválido o ha expirado." });
  }
});

const initDefaultAdmin = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@empresa.com';
    const defaultPass = process.env.ADMIN_PASSWORD || 'admin123';

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(100);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);

    const hashedPassword = await bcrypt.hash(defaultPass, 10);

    const check = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1)`,
      [adminEmail]
    );

    if (check.rows.length === 0) {
      await pool.query(
        `INSERT INTO users (email, password, password_hash, role, is_active, created_at) 
         VALUES ($1, $2, $2, 'admin', true, NOW())`,
        [adminEmail, hashedPassword]
      );
      console.log(`🔒 Cuenta Administrador inicial creada: ${adminEmail} / ${defaultPass}`);
    } else {
      await pool.query(
        `UPDATE users 
         SET password = $1, password_hash = $1, is_active = true, role = 'admin' 
         WHERE LOWER(email) = LOWER($2)`,
        [hashedPassword, adminEmail]
      );
      console.log(`🔑 Administrador ${adminEmail} verificado y contraseña resincronizada.`);
    }
  } catch (err) {
    console.error("⚠️ Error en inicialización del Admin:", err.message);
  }
};

// ============================================================================
// 🟢 MIGRACIÓN AUTOMÁTICA DE ESQUEMA PARA EVITAR ERRORES DE COLUMNAS EN RAILWAY
// ============================================================================
async function checkAndFixSchema() {
  try {
    console.log("🛠️ Verificando y corrigiendo esquema de PostgreSQL...");

    // 1. Asegurar columnas faltantes en 'employees'
    await pool.query(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS hire_date DATE,
      ADD COLUMN IF NOT EXISTS street VARCHAR(255),
      ADD COLUMN IF NOT EXISTS exterior_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS interior_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(255),
      ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS municipality VARCHAR(255),
      ADD COLUMN IF NOT EXISTS state VARCHAR(255),
      ADD COLUMN IF NOT EXISTS fiscal_street VARCHAR(255),
      ADD COLUMN IF NOT EXISTS fiscal_exterior_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS fiscal_interior_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS fiscal_neighborhood VARCHAR(255),
      ADD COLUMN IF NOT EXISTS fiscal_postal_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS fiscal_municipality VARCHAR(255),
      ADD COLUMN IF NOT EXISTS fiscal_state VARCHAR(255),
      ADD COLUMN IF NOT EXISTS job_activities TEXT,
      ADD COLUMN IF NOT EXISTS work_schedule VARCHAR(255),
      ADD COLUMN IF NOT EXISTS base_daily_salary NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS sdi_salary NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS base_salary NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS payroll_type VARCHAR(10) DEFAULT 'QUI',
      ADD COLUMN IF NOT EXISTS has_infonavit_credit VARCHAR(5) DEFAULT 'NO',
      ADD COLUMN IF NOT EXISTS infonavit_credit_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS infonavit_discount_value NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50),
      ADD COLUMN IF NOT EXISTS bank_clabe VARCHAR(50),
      ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS emergency_contact_relationship VARCHAR(100),
      ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(50),
      ADD COLUMN IF NOT EXISTS beneficiary_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS beneficiary_relationship VARCHAR(100),
      ADD COLUMN IF NOT EXISTS beneficiary_phone VARCHAR(50);
    `);
    console.log("✅ Tabla 'employees' actualizada con todas las columnas necesarias.");

    // 2. Crear la tabla 'leave_requests' si no existe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID,
        leave_type VARCHAR(100),
        request_type VARCHAR(100) DEFAULT 'vacaciones',
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days_requested INT DEFAULT 1,
        status VARCHAR(50) DEFAULT 'pendiente',
        comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Tabla 'leave_requests' verificada/creada.");

  } catch (err) {
    console.error("❌ Error durante la verificación del esquema:", err.message);
  }
}

// 4. INICIALIZACIÓN DEL SERVIDOR
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  await checkAndFixSchema();
  await initDefaultAdmin();
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});