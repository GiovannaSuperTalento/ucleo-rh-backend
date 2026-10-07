function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function publicError(message) {
  return Object.assign(new Error(message), { publicMessage: true });
}

async function sendAssessmentInvitation({ to, candidateName, vacancyTitle, assessmentTitle, link, expiresAt, durationMinutes, questionCount }) {
  const relayUrl = String(process.env.ATS_RELAY_URL || "").trim();
  const relaySecret = String(process.env.ATS_RELAY_SECRET || "").trim();
  if (!relayUrl || !relaySecret) {
    throw publicError("Faltan ATS_RELAY_URL y ATS_RELAY_SECRET en las variables del backend de Railway.");
  }
  if (!/^https:\/\//i.test(relayUrl) || !/\/exec(?:\?.*)?$/i.test(relayUrl)) {
    throw publicError("ATS_RELAY_URL debe ser la URL HTTPS de implementación de Apps Script que termina en /exec.");
  }
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) {
    throw publicError("El correo del candidato no tiene un formato válido.");
  }

  const safeName = escapeHtml(candidateName || "candidato/a");
  const safeTitle = escapeHtml(vacancyTitle || "la vacante");
  const safeAssessmentTitle = escapeHtml(assessmentTitle || "evaluación de selección");
  const expiryDate = new Date(expiresAt).toLocaleString("es-MX", {
    dateStyle: "long", timeStyle: "short", timeZone: "America/Mexico_City",
  });
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1B2A2E"><h2 style="color:#1B4B43">${safeAssessmentTitle}</h2><p>Hola ${safeName}:</p><p>Te invitamos a realizar esta prueba relacionada con la vacante <strong>${safeTitle}</strong>.</p><p>Incluye ${Number(questionCount)} preguntas y toma aproximadamente ${Number(durationMinutes)} minutos.</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#1B4B43;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Iniciar evaluación</a></p><p>El enlace vence el ${escapeHtml(expiryDate)} y solo permite un envío de respuestas.</p><p style="font-size:12px;color:#64748b">Tus respuestas se compartirán con el equipo de reclutamiento. Las preguntas abiertas se revisan manualmente; la puntuación automática corresponde a preguntas objetivas.</p></div>`;
  const text = `Hola ${candidateName || ""},\n\nTe invitamos a realizar “${assessmentTitle || "evaluación de selección"}” para la vacante ${vacancyTitle || ""}. Incluye ${questionCount} preguntas y toma aproximadamente ${durationMinutes} minutos.\n\nInicia aquí: ${link}\n\nEl enlace vence el ${expiryDate}. Tus respuestas se compartirán con el equipo de reclutamiento.`;
  const payload = {
    secret: relaySecret,
    to: String(to).trim(),
    subject: `${assessmentTitle || "Evaluación de selección"}: ${vacancyTitle || "la vacante"}`,
    text,
    html,
  };

  let response;
  let result;
  try {
    response = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const responseText = await response.text();
    try {
      result = JSON.parse(responseText);
    } catch {
      result = null;
    }
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw publicError("Apps Script tardó demasiado en responder. El borrador se conservó; revisa su implementación antes de reintentar.");
    }
    throw publicError("No se pudo conectar con el servicio de correo de Apps Script desde Railway. Revisa la URL y el despliegue.");
  }

  if (!response.ok || !result || result.ok !== true) {
    const detail = String(result?.error || "").slice(0, 300);
    console.error("Apps Script rechazó el envío ATS:", response.status, detail || "respuesta no JSON");
    if (/cuota|quota|limit/i.test(detail)) {
      throw publicError("Gmail alcanzó su cuota diaria de envío. Espera a que se restablezca antes de reintentar.");
    }
    if (/no autorizado|unauthorized/i.test(detail)) {
      throw publicError("Apps Script rechazó la clave del puente. Confirma que ATS_RELAY_SECRET coincida con ATS_RELAY_SECRET en las propiedades del script.");
    }
    throw publicError("Apps Script no pudo aceptar el correo. Confirma que la implementación esté activa y permita el acceso requerido.");
  }

  return { id: result.id || null };
}

module.exports = { sendAssessmentInvitation };
