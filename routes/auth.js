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
// ---------------------------------------------------------------
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "El correo es obligatorio." });

  const genericResponse = { message: "Si el correo existe en nuestro sistema, te enviamos un enlace para restablecer tu contraseña." };

  try {
    const result = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (result.rows.length === 0) {
      return res.json(genericResponse);
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
    res.json(genericResponse);
  }
});

// ---------------------------------------------------------------
// CONFIRMAR NUEVA CONTRASEÑA
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
// LISTAR USUARIOS (solo admin)
// ---------------------------------------------------------------
router.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.is_active, u.created_at, COALESCE(r.name, u.role, 'empleado') AS role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
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
// ---------------------------------------------------------------
router.post("/register", async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password || !role) {
    return res.status(400).json({ message: "Faltan datos: email, password y role son obligatorios." });
  }

  try {
    const existing = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Ya existe un usuario con ese correo." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await pool.query(
      "INSERT INTO users (email, password_hash, is_active, created_at) VALUES ($1, $2, true, NOW()) RETURNING id, email",
      [email, passwordHash]
    );
    const user = userResult.rows[0];

    const roleResult = await pool.query("SELECT id FROM roles WHERE LOWER(name) = LOWER($1)", [role]);
    if (roleResult.rows.length > 0) {
      const roleId = roleResult.rows[0].id;
      await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [user.id, roleId]);
    }

    res.status(201).json({ message: "Usuario creado correctamente.", user: { id: user.id, email: user.email, role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error al crear el usuario." });
  }
});

// ---------------------------------------------------------------
// LOGIN (CON DIAGNÓSTICO Y SOPORTE MULTI-ESQUEMA)
// ---------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Faltan datos: email y password son obligatorios." });
  }

  try {
    console.log(`🔍 [AUTH] Intento de login para: ${email}`);

    // Consulta resiliente con LEFT JOIN
    const result = await pool.query(
      `SELECT u.id, u.email, u.password, u.password_hash, u.is_active, u.team_id,
              COALESCE(r.name, u.role, 'admin') AS role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE LOWER(u.email) = LOWER($1)`,
      [email]
    );

    if (result.rows.length === 0) {
      console.warn(`❌ [AUTH] Usuario no encontrado: ${email}`);
      return res.status(401).json({ message: "Correo o contraseña incorrectos." });
    }

    const user = result.rows[0];

    if (user.is_active === false) {
      console.warn(`⚠️ [AUTH] Cuenta desactivada para: ${email}`);
      return res.status(403).json({ message: "Esta cuenta está desactivada. Contacta a un administrador." });
    }

    // Detectar si el hash está en 'password_hash' o 'password'
    const storedHash = user.password_hash || user.password;

    if (!storedHash) {
      console.error(`💥 [AUTH] El usuario ${email} no tiene ninguna contraseña o hash guardado.`);
      return res.status(401).json({ message: "Error de configuración de credenciales." });
    }

    // Comparar la contraseña ingresada con el hash cifrado
    const validPassword = await bcrypt.compare(password, storedHash);
    
    if (!validPassword) {
      console.warn(`🔑 [AUTH] Contraseña incorrecta para: ${email}`);
      return res.status(401).json({ message: "Correo o contraseña incorrectos." });
    }

    console.log(`✅ [AUTH] Login exitoso para: ${email} (${user.role})`);

    // Buscar si el usuario tiene un perfil de empleado vinculado
    const employeeResult = await pool.query("SELECT id FROM employees WHERE LOWER(personal_email) = LOWER($1)", [email]);
    const employeeId = employeeResult.rows[0]?.id || null;

    // Generar el token JWT de acceso
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: user.role, 
        team_id: user.team_id || 1, 
        employeeId 
      },
      process.env.JWT_SECRET || "secreto_desarrollo",
      { expiresIn: "8h" }
    );

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        role: user.role, 
        team_id: user.team_id || 1, 
        employeeId 
      } 
    });
  } catch (err) {
    console.error("💥 [AUTH ERROR]:", err);
    res.status(500).json({ message: "Error interno al iniciar sesión." });
  }
});

// ---------------------------------------------------------------
// EDITAR USUARIO (solo admin)
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
      await pool.query("UPDATE users SET password_hash = $1, password = $1 WHERE id = $2", [passwordHash, id]);
    }

    if (role) {
      const roleResult = await pool.query("SELECT id FROM roles WHERE LOWER(name) = LOWER($1)", [role]);
      if (roleResult.rows.length > 0) {
        await pool.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
        await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, roleResult.rows[0].id]);
      }
      await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
    }

    res.json({ message: "Usuario actualizado correctamente." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "No se pudo actualizar el usuario." });
  }
});

// ---------------------------------------------------------------
// ELIMINAR USUARIO (solo admin)
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

// ---------------------------------------------------------------
// REGISTRO DE EQUIPO + ADMIN
// ---------------------------------------------------------------
router.post("/register-team", async (req, res) => {
  const { team_name, user_email, password, full_name } = req.body;

  if (!team_name || !user_email || !password) {
    return res.status(400).json({ message: "Nombre de empresa, correo y contraseña son obligatorios." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userExist = await client.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [user_email]);
    if (userExist.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "El correo electrónico ya está registrado." });
    }

    const slug = team_name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Math.floor(1000 + Math.random() * 9000);
    const newTeam = await client.query(
      `INSERT INTO teams (name, slug, created_at) VALUES ($1, $2, NOW()) RETURNING *`,
      [team_name, slug]
    );
    const teamId = newTeam.rows[0].id;

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await client.query(
      `INSERT INTO users (email, password, password_hash, name, role, team_id, team_role, is_active, created_at)
       VALUES ($1, $2, $2, $3, 'admin', $4, 'owner', true, NOW()) RETURNING id, email, name, role, team_id`,
      [user_email, hashedPassword, full_name || team_name, teamId]
    );

    await client.query("COMMIT");

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