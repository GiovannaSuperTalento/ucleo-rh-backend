const express = require("express");
const pool = require("../db");

const router = express.Router();

router.post("/chat", async (req, res) => {
  const { message, userEmail: bodyEmail } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ message: "El mensaje es obligatorio." });
  }

  const rawKey = process.env.GEMINI_API_KEY || "";
  const apiKey = rawKey
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\r\n\t]/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!apiKey || apiKey.length < 10) {
    console.error("❌ ERROR AI: La GEMINI_API_KEY no está configurada correctamente.");
    return res.json({ 
      reply: "⚠️ La clave GEMINI_API_KEY no está configurada correctamente en el archivo .env." 
    });
  }

  const now = new Date();
  const currentDateStr = now.toLocaleDateString("es-MX", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
  const currentTimeStr = now.toLocaleTimeString("es-MX", {
    hour: "2-digit", minute: "2-digit"
  });

  const queryLower = message.trim().toLowerCase();

  if (queryLower.includes("fecha") || queryLower.includes("día es hoy") || queryLower.includes("hora")) {
    return res.json({ 
      reply: `Hoy es ${currentDateStr} y la hora actual en el servidor es ${currentTimeStr}.` 
    });
  }

  try {
    let allTasksFound = [];
    let allLeavesFound = [];
    let systemContext = "";

    try {
      const qTasks = await pool.query(
        `SELECT id, title, description, priority, due_date, created_at FROM tasks ORDER BY created_at DESC LIMIT 20`
      ).catch(() => ({ rows: [] }));

      qTasks.rows.forEach((t, idx) => {
        const title = t.title || "Tarea sin título";
        const desc = t.description ? `- ${t.description}` : "";
        const priority = t.priority ? `[Prioridad: ${t.priority}]` : "";
        const dueDate = t.due_date ? `(Vence/Fecha: ${String(t.due_date).slice(0, 10)})` : "";

        allTasksFound.push(`${idx + 1}. "${title}" ${desc} ${priority} ${dueDate}`);
      });
    } catch (e) {
      console.error("❌ Error al consultar la tabla tasks:", e.message);
    }

    try {
      const qLeaves = await pool.query(
        `SELECT lr.request_type, lr.start_date, lr.end_date, lr.status, e.first_name, e.last_name
         FROM leave_requests lr
         LEFT JOIN employees e ON lr.employee_id::text = e.id::text
         ORDER BY lr.id DESC LIMIT 15`
      ).catch(() => ({ rows: [] }));

      qLeaves.rows.forEach((l, idx) => {
        const empName = l.first_name ? `${l.first_name} ${l.last_name}` : "Empleado";
        const type = l.request_type || "Vacaciones/Permiso";
        const startDate = l.start_date ? String(l.start_date).slice(0, 10) : "N/A";
        const endDate = l.end_date ? String(l.end_date).slice(0, 10) : "N/A";
        const status = l.status || "pendiente";

        allLeavesFound.push(`${idx + 1}. Permiso/Vacaciones de ${empName}: ${type} del ${startDate} al ${endDate} (Estatus: ${status})`);
      });
    } catch (e) {
      console.error("❌ Error al consultar solicitudes:", e.message);
    }

    let contextSummary = "";

    if (allTasksFound.length > 0) {
      contextSummary += `\n📌 NOTAS, POST-ITS Y PENDIENTES REGISTRADOS EN EL SISTEMA:\n${allTasksFound.join("\n")}\n`;
    } else {
      contextSummary += `\n📌 NOTAS Y PENDIENTES: No hay tareas registradas en la base de datos.\n`;
    }

    if (allLeavesFound.length > 0) {
      contextSummary += `\n📅 ACTIVIDADES, EVENTOS Y PERMISOS REGISTRADOS:\n${allLeavesFound.join("\n")}\n`;
    } else {
      contextSummary += `\n📅 ACTIVIDADES Y PERMISOS: No hay eventos agendados.\n`;
    }

    const fullPrompt = `
    Eres "NúcleoBot", el asistente virtual de Recursos Humanos para "Núcleo RH".
    Responde de forma amable, profesional, clara y estructurada en español.

    FECHA Y HORA ACTUALES DEL SISTEMA:
    Hoy es ${currentDateStr} y son las ${currentTimeStr}.

    ===================================================
    INFORMACIÓN REAL EXTRAÍDA DE LA BASE DE DATOS DE NÚCLEO RH:
    ${contextSummary}
    ===================================================

    REGLAS ESTRICTAS DE RESPUESTA:
    1. Si el usuario pregunta por sus pendientes, notas, post-its, tareas o actividades, MUESTRA Y LISTA CADA UNO de los elementos encontrados arriba.
    2. Si arriba hay elementos presentes en la lista, NUNCA respondas que "no tienes pendientes o notas registradas".
    3. NUNCA reveles salarios, cuentas bancarias ni contraseñas.
    4. Responde con viñetas claras y concisas.

    Pregunta del usuario: ${message.trim()}
    `;

    // Modelo actualizado oficialmente por Google
    const candidateModels = ["gemini-3.6-flash"];
    let lastErrorData = null;

    for (const modelName of candidateModels) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      
      try {
        const apiResponse = await fetch(url, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }]
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        const data = await apiResponse.json();

        if (apiResponse.ok && data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
          return res.json({ reply: data.candidates[0].content.parts[0].text });
        }

        lastErrorData = data;
      } catch (fetchErr) {
        clearTimeout(timeoutId);
      }
    }

    return res.json({ 
      reply: lastErrorData?.error?.message 
        ? `Respuesta de Google AI: ${lastErrorData.error.message}` 
        : "En este momento no fue posible procesar la consulta con el servidor de la IA." 
    });

  } catch (err) {
    console.error("❌ EXCEPCIÓN EN EL SERVIDOR DE IA:", err);
    return res.json({ reply: `Error interno en el servidor: ${err.message}` });
  }
});

module.exports = router;