const express = require("express");
const router = express.Router();

// 🟢 Endpoint POST /api/ai/chat
router.post("/chat", async (req, res) => {
  const { message } = req.body;
  try {
    // Respuesta asistida básica de RH
    const reply = `Hola, recibí tu consulta: "${message}". Estoy listo para apoyarte con las políticas internas, vacaciones, expedientes y documentos de Núcleo RH.`;
    
    res.json({ reply });
  } catch (err) {
    console.error("Error en la IA:", err);
    res.status(500).json({ message: "Error al procesar la solicitud con la IA." });
  }
});

module.exports = router;