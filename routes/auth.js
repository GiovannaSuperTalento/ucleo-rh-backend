// routes/auth.js
// Define dos endpoints:
//   POST /api/auth/register  -> crea un usuario nuevo (con contraseña cifrada)
//   POST /api/auth/login     -> verifica credenciales y entrega un token JWT

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendPasswordResetEmail } = require("../mailer");

const router = express.Router();

// ---------------------------------------------------------------
// SOLICITAR RECUPERACIÓN DE CONTRASEÑA
// body: { email }
// Por seguridad, siempre respondemos el mismo mensaje exista o no
// el correo — así nadie puede usar este endpoint para "adivinar"
// qué correos están registrados en el sistema.
// ---------------------------------------------------------------
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "El correo es obligatorio." });

  const genericResponse = { message: "Si el correo existe en nuestro sistema, te enviamos un enlace para restablecer tu contraseña." };

  try {
    const result = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) {
      return res.json(genericResponse); // no revelamos si el correo existe o no
    }

    const userId = result.rows[0].id;
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await pool.query("UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3", [token, expires, userId]);

    const resetLink = `${process.env.FRONTEND_URL}/?resetToken=${token}`;
    await sendPasswordResetEmail(email, resetLink);

    res.json(genericResponse);
  } catch (err) {
    console.error(err);
    // Aun si falla el envío, no revelamos detalles internos al usuario
    res.json(genericResponse);
  }
});

// ---------------------------------------------------------------
// CONFIRMAR NUEVA CONTRASEÑA
// body: { token, password }
// ---------------------------------------------------------------
router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ message: "Token y nueva contraseña son obligatorios." });
  }

  try {
    const result = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "El enlace es inválido o ya expiró. Solicita uno nuevo." });
    }

    const userId = result.rows[0].id;
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      "UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2",
      [passwordHash, userId]
    );

    res.json({ message: "Tu contraseña fue actualizada correctamente. Ya puedes iniciar sesión." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "No se pudo restablecer la contraseña." });
  }
});

// ---------------------------------------------------------------
// LISTAR USUARIOS (solo admin) — para la sección "Usuarios" del panel
// ---------------------------------------------------------------
router.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.is_active, u.created_at, r.name AS role
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       ORDER BY u.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "No se pudo obtener la lista de usuarios." });
  }
});

// ---------------------------------------------------------------
// REGISTRO
// body esperado: { email, password, role: "admin" | "empleado" }
// ---------------------------------------------------------------
router.post("/register", async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password || !role) {
    return res.status(400).json({ message: "Faltan datos: email, password y role son obligatorios." });
  }

  try {
    // 1) Verificar que el correo no exista ya
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Ya existe un usuario con ese correo." });
    }

    // 2) Cifrar la contraseña (nunca se guarda en texto plano)
    const passwordHash = await bcrypt.hash(password, 10);

    // 3) Insertar el usuario
    const userResult = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
      [email, passwordHash]
    );
    const user = userResult.rows[0];

    // 4) Buscar el id del rol solicitado
    const roleResult = await pool.query("SELECT id FROM roles WHERE name = $1", [role]);
    if (roleResult.rows.length === 0) {
      return res.status(400).json({ message: `El rol '${role}' no existe. Usa 'admin' o 'empleado'.` });
    }
    const roleId = roleResult.rows[0].id;

    // 5) Asignar el rol al usuario
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [user.id, roleId]);

    res.status(201).json({ message: "Usuario creado correctamente.", user: { id: user.id, email: user.email, role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error al crear el usuario." });
  }
});

// ---------------------------------------------------------------
// LOGIN
// body esperado: { email, password }
// ---------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Faltan datos: email y password son obligatorios." });
  }

  try {
    // 1) Buscar al usuario junto con su rol
    const result = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.is_active, r.name AS role
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Correo o contraseña incorrectos." });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ message: "Esta cuenta está desactivada. Contacta a un administrador." });
    }

    // 2) Comparar la contraseña enviada contra el hash guardado
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ message: "Correo o contraseña incorrectos." });
    }

    // 3) Buscar si este usuario tiene un empleado vinculado (por el mismo correo)
    const employeeResult = await pool.query("SELECT id FROM employees WHERE personal_email = $1", [email]);
    const employeeId = employeeResult.rows[0]?.id || null;

    // 4) Generar el token JWT (esto es lo que el frontend guardará como "sesión")
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, employeeId },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({ token, user: { id: user.id, email: user.email, role: user.role, employeeId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error al iniciar sesión." });
  }
});

// ---------------------------------------------------------------
// EDITAR USUARIO (solo admin) — cambiar rol, activar/desactivar, resetear contraseña
// body: { role?, is_active?, password? }
// ---------------------------------------------------------------
router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { role, is_active, password } = req.body;

  try {
    if (is_active !== undefined) {
      await pool.query("UPDATE users SET is_active = $1 WHERE id = $2", [is_active, id]);
    }

    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, id]);
    }

    if (role) {
      const roleResult = await pool.query("SELECT id FROM roles WHERE name = $1", [role]);
      if (roleResult.rows.length === 0) {
        return res.status(400).json({ message: `El rol '${role}' no existe.` });
      }
      await pool.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
      await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, roleResult.rows[0].id]);
    }

    res.json({ message: "Usuario actualizado correctamente." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "No se pudo actualizar el usuario." });
  }
});

// ---------------------------------------------------------------
// ELIMINAR USUARIO (solo admin) — no puedes eliminar tu propia cuenta
// ---------------------------------------------------------------
router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;

  if (id === req.user.id) {
    return res.status(400).json({ message: "No puedes eliminar tu propia cuenta." });
  }

  try {
    await pool.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }
    res.json({ message: "Usuario eliminado correctamente." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "No se pudo eliminar el usuario." });
  }
});
// POST /api/auth/register-team -> Registro público de nuevo Equipo + Administrador
router.post("/register-team", async (req, res) => {
  const { team_name, user_email, password, full_name } = req.body;

  if (!team_name || !user_email || !password) {
    return res.status(400).json({ message: "Nombre de empresa, correo y contraseña son obligatorios." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verificar si el usuario ya existe
    const userExist = await client.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [user_email]);
    if (userExist.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "El correo electrónico ya está registrado." });
    }

    // 1. Crear el nuevo Equipo
    const slug = team_name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Math.floor(1000 + Math.random() * 9000);
    const newTeam = await client.query(
      `INSERT INTO teams (name, slug, created_at) VALUES ($1, $2, NOW()) RETURNING *`,
      [team_name, slug]
    );
    const teamId = newTeam.rows[0].id;

    // 2. Hash de contraseña y creación del Usuario Dueño/Admin
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await client.query(
      `INSERT INTO users (email, password, name, role, team_id, team_role, created_at)
       VALUES ($1, $2, $3, 'admin', $4, 'owner', NOW()) RETURNING id, email, name, role, team_id`,
      [user_email, hashedPassword, full_name || team_name, teamId]
    );

    await client.query("COMMIT");

    // 3. Generar Token JWT enriquecido con el team_id
    const token = jwt.sign(
      { id: newUser.rows[0].id, email: newUser.rows[0].email, role: "admin", team_id: teamId },
      process.env.JWT_SECRET || "secreto_rh",
      { expiresIn: "24h" }
    );

    res.status(201).json({
      message: "¡Empresa y cuenta administrativa creadas exitosamente!",
      token,
      user: newUser.rows[0],
      team: newTeam.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error en registro de equipo:", err);
    res.status(500).json({ message: "Error al registrar la empresa: " + err.message });
  } finally {
    client.release();
  }
});
module.exports = router;
