// mailer.js
// Configura el envío de correos usando una cuenta de Gmail y una
// "contraseña de aplicación" (App Password), no tu contraseña normal.

require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendPasswordResetEmail(toEmail, resetLink) {
  await transporter.sendMail({
    from: `"Núcleo RH" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "Recupera tu contraseña — Núcleo RH",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#1B4B43;">Recupera tu contraseña</h2>
        <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en Núcleo RH.</p>
        <p>
          <a href="${resetLink}" style="display:inline-block; background:#1B4B43; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none;">
            Crear nueva contraseña
          </a>
        </p>
        <p style="color:#5B6B6E; font-size:13px;">Este enlace vence en 1 hora. Si tú no solicitaste esto, puedes ignorar este correo.</p>
      </div>
    `,
  });
}

module.exports = { sendPasswordResetEmail };
