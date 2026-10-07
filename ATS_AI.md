# Proveedores de IA para el ATS

El ATS siempre conserva su análisis local. Si se configura un proveedor, intenta
Groq primero, Gemini después y OpenAI al final si se activan. Continúa con el
siguiente proveedor cuando hay un error, límite de uso, respuesta inválida o
falta de conexión. Si todos fallan, usa el análisis local sin impedir el
registro del candidato.

## Opción gratuita: Groq

Configura `GROQ_API_KEY` como variable de entorno del backend (por ejemplo, en
Railway > servicio del backend > Variables). El modelo predeterminado es
`qwen/qwen3.8-27b`; puedes cambiarlo con `ATS_GROQ_MODEL`. Groq publica cuotas
gratuitas sujetas a límites y cambios; al excederlas, el ATS pasará al siguiente
proveedor activado o al análisis local.

No pongas claves en el repositorio, en el frontend ni en mensajes. La IA recibe
el texto extraído del CV, que puede contener datos personales. Revisa las
políticas del proveedor y obtén las autorizaciones que correspondan antes de
activar su uso con CV reales.

## Proveedores de respaldo opcionales

- OpenAI API: configurar `OPENAI_API_KEY` y `ATS_OPENAI_CV_ENABLED=true`. El
  uso de la API se factura aparte de una suscripción de ChatGPT.
- OpenRouter: configurar `OPENROUTER_API_KEY` y activar explícitamente
  `ATS_OPENROUTER_CV_ENABLED=true`. El modelo predeterminado es
  `openrouter/free` (se puede cambiar con `ATS_OPENROUTER_CV_MODEL`). La
  solicitud exige proveedores con denegación de recopilación de datos y Zero
  Data Retention; si no hay un modelo gratuito que cumpla ambas condiciones,
  este intento falla y el ATS continúa con los demás proveedores o el análisis
  local.
- Gemini: configurar `ATS_GEMINI_API_KEY` y `ATS_GEMINI_CV_PAID=true` únicamente
  para un proyecto con facturación habilitada. Si `ATS_GEMINI_API_KEY` no está
  definida, se usa `GEMINI_API_KEY` como alternativa para instalaciones que ya
  tengan esa variable. No se envían CV a Gemini con acceso gratuito.

Modelos opcionales: `ATS_OPENAI_MODEL` (predeterminado `gpt-4.1-mini`) y
`ATS_GEMINI_CV_MODEL` (predeterminado `gemini-3.6-flash`). La variable de
Gemini para pruebas (`ATS_GEMINI_ASSESSMENT_MODEL`) no cambia el modelo para CV.
Las claves se leen solo en el backend.

La IA extrae datos y ubica evidencia textual para requisitos, responsabilidades,
conocimientos específicos, habilidades blandas y niveles de idioma/Excel que
se hayan definido en la vacante. El resultado muestra una explicación por
criterio y las citas que la respaldan. El servidor
verifica las citas contra el texto del CV; la cobertura parcial cuenta como
media. No es una recomendación de contratación. El análisis se mantiene
disponible aunque no haya proveedor, y el resultado estructurado se conserva
solo temporalmente en memoria para evitar gastar cuota dos veces durante la
vista previa y el registro.

## Generación de evaluaciones

Al crear borradores de conocimientos del puesto, habilidades blandas o
evaluaciones integrales, el backend intenta Groq, Gemini y OpenRouter en ese
orden, cuando sus claves están configuradas. Para añadir el tercer proveedor,
agrega `OPENROUTER_API_KEY` en las variables privadas del backend; usa
`openrouter/free` como modelo predeterminado o cambia `ATS_OPENROUTER_MODEL`.
OpenRouter publica actualmente un plan gratuito con límites y disponibilidad
que pueden cambiar. Envía solo la información de la vacante, no el CV ni los
datos personales del candidato. Consulta las políticas de retención del modelo
gratuito que se seleccione antes de enviar información confidencial.

Las preguntas generadas deben ser específicas, cubrir las responsabilidades y
requisitos de experiencia, y contener una rúbrica verificable para las
respuestas abiertas. El backend valida las respuestas de IA. Si Groq, Gemini y
OpenRouter fallan, activa un generador local basado en escenarios: usa responsabilidades,
requisitos y conocimientos de la vacante para redactar preguntas abiertas con
rúbricas, sin depender de conexión ni claves externas. La interfaz identifica
este mecanismo y RH debe revisar y editar el borrador antes del envío. Las
preguntas abiertas se califican manualmente.
