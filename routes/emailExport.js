const express = require("express");
const nodemailer = require("nodemailer");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// CONFIGURACIÓN DEL TRANSPORTE DE GMAIL
// Nota: Se recomienda colocar estas credenciales en tu archivo .env
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER || "tu-correo-empresa@gmail.com", // Tu correo de envío
    pass: process.env.GMAIL_PASS || "tu-contrasena-de-aplicacion",  // Contraseña de aplicación de Google
  },
});

// POST /api/export/send-email -> Enviar reporte Excel por correo
router.post("/send-email", async (req, res) => {
  const { recipient_email, subject, body_text, file_name, file_base64 } = req.body;

  if (!recipient_email || !file_base64) {
    return res.status(400).json({ message: "El correo de destino y el archivo son obligatorios." });
  }

  try {
    // Convertir el archivo Base64 enviado por el frontend en un Buffer
    const fileBuffer = Buffer.from(file_base64.split(",")[1] || file_base64, "base64");

    const mailOptions = {
      from: `"Núcleo RH" <${process.env.GMAIL_USER || "notificaciones@nucleorh.com"}>`,
      to: recipient_email,
      subject: subject || "Reporte de Recursos Humanos — Núcleo RH",
      text: body_text || "Adjunto a este correo encontrarás el reporte solicitado desde la plataforma Núcleo RH.",
      attachments: [
        {
          filename: file_name || "Reporte_RH.xlsx",
          content: fileBuffer,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: "Correo enviado con éxito a " + recipient_email });
  } catch (err) {
    console.error("Error al enviar correo con Nodemailer:", err);
    res.status(500).json({ message: "No se pudo enviar el correo: " + err.message });
  }
});

module.exports = router;