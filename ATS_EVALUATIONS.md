# Evaluaciones para candidatos del ATS

## Qué genera el sistema

Los borradores de conocimientos del puesto, habilidades blandas y evaluación
integral se generan con IA a partir de la descripción, responsabilidades,
requisitos de experiencia y conocimientos específicos de la vacante. Las
preguntas abiertas incluyen una rúbrica de cuatro criterios; las preguntas
objetivas incluyen una clave para calificación automática. RH puede editar y
revisar todas las preguntas y respuestas antes de enviarlas. La generación usa
Groq, Gemini y OpenRouter como respaldos si están configurados. Si los
proveedores no responden, el backend usa un generador local que crea escenarios abiertos desde las responsabilidades,
requisitos y conocimientos de la vacante, sin bloquear el borrador. La pantalla
identifica claramente ese mecanismo para que RH revise el resultado con cuidado.

Las pruebas aisladas de Excel e inglés conservan los cuestionarios existentes
por nivel configurado. Las respuestas abiertas y las habilidades blandas se
puntúan manualmente por RH; no hay diagnóstico de personalidad ni decisión
automática de contratación.

En cada vacante captura actividades concretas en renglones separados. En
“Conocimientos o procesos específicos a evaluar” agrega procedimientos,
normativa, herramientas o conocimientos que quieras medir con mayor detalle.

## Correo y enlace

Para enviar desde Railway, el backend llama por HTTPS a un puente de Google
Apps Script, que usa `MailApp` para enviar desde la cuenta que publicó el
puente. No requiere SMTP, comprar/verificar un dominio ni configurar credenciales
OAuth de Gmail en el backend. Configura `ATS_RELAY_URL` con la URL `/exec` de la
implementación web de Apps Script y `ATS_RELAY_SECRET` con la misma clave que
guardaste en las propiedades del script. Ambas son variables privadas del
servicio backend. No las agregues al frontend ni al repositorio.

El enlace aleatorio se comparte por correo, vence en siete días y acepta un solo
envío. Las cuentas Gmail personales tienen un límite diario de envío en Apps
Script; Google publica actualmente una cuota de 100 destinatarios al día, sujeta
a cambios y a límites adicionales de la cuenta.

Las respuestas objetivas se califican al enviar. Las respuestas prácticas y de
habilidades blandas requieren una puntuación manual de RH (0–8 por pregunta,
cuatro criterios de rúbrica con 0–2 puntos cada uno). Las puntuaciones se
guardan en el expediente y en el seguimiento de la postulación.
