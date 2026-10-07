const crypto = require("crypto");

function choiceQuestion({ category, prompt, options, answer, level = null }) {
  const shuffledOptions = options.map((text, index) => ({ text, originalIndex: index }));
  for (let index = shuffledOptions.length - 1; index > 0; index--) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffledOptions[index], shuffledOptions[swapIndex]] = [shuffledOptions[swapIndex], shuffledOptions[index]];
  }
  const preparedOptions = shuffledOptions.map((option, index) => ({ id: String.fromCharCode(97 + index), text: option.text }));
  const correctIndex = Number.isInteger(answer) ? answer : String(answer).charCodeAt(0) - 97;
  return {
    id: crypto.randomUUID(),
    category,
    type: "single_choice",
    prompt,
    options: preparedOptions,
    correctOptionId: preparedOptions.find((_, index) => shuffledOptions[index].originalIndex === correctIndex)?.id,
    points: 1,
    level,
  };
}

function writtenQuestion({ category, prompt, rubric }) {
  return { id: crypto.randomUUID(), category, type: "written", prompt, rubric, points: 0 };
}

const EXCEL_TESTS = {
  basico: [
    choiceQuestion({ category: "Excel", level: "Básico", prompt: "¿Qué fórmula suma los valores de las celdas A1 a A10?", options: ["=SUMA(A1:A10)", "=CONTAR(A1:A10)", "=PROMEDIO(A1:A10)", "=UNIR(A1:A10)"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Básico", prompt: "¿Para qué sirve principalmente un filtro en una tabla?", options: ["Mostrar solo filas que cumplen condiciones", "Borrar permanentemente filas", "Cambiar las fórmulas", "Proteger el archivo con contraseña"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Básico", prompt: "¿Qué referencia mantiene fija una celda al copiar una fórmula?", options: ["$A$1", "A1", "A:A", "1A"], answer: "a" }),
  ],
  intermedio: [
    choiceQuestion({ category: "Excel", level: "Intermedio", prompt: "¿Qué función permite devolver un valor cuando una condición es verdadera y otro cuando es falsa?", options: ["SI", "CONTAR", "HOY", "CONCAT"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Intermedio", prompt: "¿Qué herramienta resume y agrupa datos de una tabla por categorías?", options: ["Tabla dinámica", "Formato de celda", "Validación de datos", "Buscar y reemplazar"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Intermedio", prompt: "¿Qué función moderna busca un valor en una matriz y devuelve el valor relacionado?", options: ["BUSCARX", "REDONDEAR", "IZQUIERDA", "AHORA"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Intermedio", prompt: "En $B$4, ¿qué parte queda fija al copiar la fórmula?", options: ["Columna B y fila 4", "Solo columna B", "Solo fila 4", "Ninguna"], answer: "a" }),
  ],
  avanzado: [
    choiceQuestion({ category: "Excel", level: "Avanzado", prompt: "¿Qué función suma valores que cumplen varios criterios?", options: ["SUMAR.SI.CONJUNTO", "CONTARA", "SUBTOTALES", "INDIRECTO"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Avanzado", prompt: "¿Qué combinación es una alternativa flexible para buscar en una tabla cuando la columna de retorno está a la izquierda o derecha?", options: ["INDICE + COINCIDIR", "SUMA + PROMEDIO", "IZQUIERDA + DERECHA", "FILA + COLUMNA"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Avanzado", prompt: "¿Qué característica permite recalcular resultados con distintos valores de entrada?", options: ["Tabla de datos de análisis de hipótesis", "Formato condicional", "Inmovilizar paneles", "Quitar duplicados"], answer: "a" }),
    choiceQuestion({ category: "Excel", level: "Avanzado", prompt: "¿Qué herramienta conviene para importar, transformar y combinar datos repetidamente?", options: ["Power Query", "Autorrelleno", "Formato de número", "Vista de salto de página"], answer: "a" }),
  ],
};

const ENGLISH_TESTS = {
  A1: [
    choiceQuestion({ category: "Inglés", level: "A1", prompt: "Choose the correct sentence.", options: ["I work in Human Resources.", "I works in Human Resources.", "I working in Human Resources.", "I am work in Human Resources."], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "A1", prompt: "Complete: The meeting is ___ Monday.", options: ["on", "at", "in", "by"], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "A1", prompt: "What does ‘Please send your résumé’ mean?", options: ["Por favor envía tu currículum", "Por favor firma el contrato", "Por favor cancela la reunión", "Por favor llama mañana"], answer: "a" }),
  ],
  A2: [
    choiceQuestion({ category: "Inglés", level: "A2", prompt: "Complete: She ___ the monthly report every Friday.", options: ["prepares", "prepare", "preparing", "is prepare"], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "A2", prompt: "Choose the most appropriate workplace request.", options: ["Could you send me the updated file, please?", "You sends me updated file.", "Send me file yesterday.", "Could you to sending file?"], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "A2", prompt: "Complete: We have worked here ___ 2022.", options: ["since", "for", "during", "from"], answer: "a" }),
  ],
  B1: [
    choiceQuestion({ category: "Inglés", level: "B1", prompt: "Complete: If the figures ___ incorrect, we would review the source data.", options: ["were", "are", "will be", "have been"], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "B1", prompt: "What does ‘We are behind schedule’ mean?", options: ["Estamos retrasados respecto al calendario", "Terminamos antes de tiempo", "El horario fue aprobado", "La reunión cambió de sala"], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "B1", prompt: "Choose the clearest professional reply to a request you cannot complete today.", options: ["I can send it tomorrow morning; would that work?", "No. Maybe later.", "I don't know, ask someone.", "You should have told me earlier."], answer: "a" }),
  ],
  B2: [
    choiceQuestion({ category: "Inglés", level: "B2", prompt: "Choose the grammatically correct sentence.", options: ["The team has completed the audit, although two items remain under review.", "The team have completed the audit, although two items remains under review.", "The team completed the audit, although two items is remaining under review.", "The team has complete the audit, although two items remain under review."], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "B2", prompt: "A colleague says a deadline is at risk. Which response best supports problem solving?", options: ["Let's identify the blocker and agree on the next steps.", "That is not my responsibility.", "You should have finished sooner.", "We can ignore the deadline."], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "B2", prompt: "In a report, ‘The results are subject to verification’ means:", options: ["Los resultados aún deben comprobarse", "Los resultados fueron descartados", "Los resultados son confidenciales", "Los resultados no tienen fecha"], answer: "a" }),
  ],
  C1: [
    choiceQuestion({ category: "Inglés", level: "C1", prompt: "Choose the most precise sentence for a formal report.", options: ["The discrepancy appears to stem from inconsistent source records; we recommend reconciling them before publication.", "There is a weird problem in the numbers and maybe someone should look.", "The numbers are wrong because the source is bad.", "We have a discrepancy, but it is not important."], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "C1", prompt: "Complete: Had the team received the revised forecast earlier, it ___ the staffing plan accordingly.", options: ["would have adjusted", "will adjust", "would adjust", "has adjusted"], answer: "a" }),
    choiceQuestion({ category: "Inglés", level: "C1", prompt: "Which phrase most clearly signals a qualified conclusion?", options: ["Based on the available evidence, the variance is primarily attributable to timing differences.", "The variance is definitely because of timing, no question.", "We guess timing is the reason.", "Timing maybe did something."], answer: "a" }),
  ],
};

function splitAreas(...values) {
  const areas = values.flatMap((value) => String(value || "")
    .replace(/(?:^|\n)\s*(?:[-*•]+|\d+[.)])\s*/g, "\n")
    .split(/[\n;•]+|(?<=[.!?])\s+/)
    .map((item) => item.replace(/^\s*(?:responsabilidades?|actividades?|requisitos?|funciones?)\s*:?\s*/i, "").trim())
    .filter((item) => item.length >= 8 && item.length <= 220));
  const seen = new Set();
  return areas.filter((area) => {
    const key = area.toLocaleLowerCase("es-MX").replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function generateAssessment(vacancy, assessmentType = "completa") {
  const questions = [];
  const roleAreas = splitAreas(
    vacancy.assessment_focus,
    vacancy.requirements,
    vacancy.responsibilities,
    vacancy.description
  );
  if (!roleAreas.length && vacancy.title) roleAreas.push(`actividades principales de ${vacancy.title}`);
  for (const area of roleAreas.slice(0, 8)) {
    questions.push(writtenQuestion({
      category: "Prueba práctica del puesto",
      prompt: `Caso práctico para “${String(vacancy.title).slice(0, 100)}”: se te asigna la actividad “${area}”. Explica, paso a paso, cómo la realizarías en una jornada real. Indica qué información o herramientas usarías, qué errores o riesgos revisarías y cómo comprobarías y comunicarías el resultado.`,
      rubric: `Evaluar manualmente el conocimiento aplicado a “${area}”: (1) pasos y lógica técnica; (2) herramientas o información pertinente; (3) controles de calidad, seguridad y manejo de errores; (4) resultado y comunicación. Puntuar cada rubro de 0 a 2 y registrar evidencia concreta de la respuesta. No inferir rasgos personales ni usar la respuesta por sí sola como decisión automática.`,
    }));
  }

  const excelLevel = String(vacancy.excel_level || "").toLowerCase();
  if (EXCEL_TESTS[excelLevel]) questions.push(...EXCEL_TESTS[excelLevel]);

  const englishLevel = String(vacancy.english_level || "").toUpperCase();
  if (ENGLISH_TESTS[englishLevel]) questions.push(...ENGLISH_TESTS[englishLevel]);

  const softSkills = [...new Set(String(vacancy.soft_skills_focus || "Comunicación, trabajo en equipo, resolución de problemas")
    .split(/[\n,;•]+/)
    .map((skill) => skill.trim())
    .filter((skill) => skill.length >= 3 && skill.length <= 100))].slice(0, 4);
  const scenarios = [
    ["Comunicación", "Recibes información incompleta que afecta una entrega. ¿Qué harías para aclararla y mantener informadas a las personas involucradas?"],
    ["Trabajo en equipo", "Un área compañera y la tuya tienen prioridades distintas para una fecha límite. ¿Cómo acordarías los siguientes pasos?"],
    ["Resolución de problemas", "Detectas una diferencia entre un reporte y el registro fuente antes de enviarlo. ¿Cómo investigas y comunicas el hallazgo?"],
    ["Organización", "Varias tareas urgentes compiten por tu tiempo. ¿Cómo priorizas, confirmas expectativas y das seguimiento?"],
  ];
  softSkills.forEach((skill, index) => {
    const scenario = scenarios[index % scenarios.length];
    questions.push(writtenQuestion({
      category: `Habilidad blanda: ${skill}`,
      prompt: `${scenario[1]} En tu respuesta considera ${skill.toLowerCase()}.`,
      rubric: `Revisar manualmente ${skill}: escucha y claridad; respeto y colaboración; razonamiento y alternativas; seguimiento y responsabilidad. Asignar 0–2 en cada rubro con evidencia en la respuesta. No es una prueba de personalidad ni produce una decisión automática.`,
    }));
  });

  const categoryPatterns = {
    puesto: /^Prueba práctica del puesto$/i,
    excel: /^Excel$/i,
    ingles: /^Inglés$/i,
    habilidades_blandas: /^Habilidad blanda:/i,
  };
  const selectedQuestions = assessmentType === "completa"
    ? questions
    : questions.filter((question) => categoryPatterns[assessmentType]?.test(question.category));
  const labels = {
    completa: "Evaluación integral",
    puesto: "Prueba práctica del puesto",
    excel: "Prueba de Excel",
    ingles: "Prueba de inglés",
    habilidades_blandas: "Prueba de habilidades blandas",
  };

  return {
    type: assessmentType,
    title: `${labels[assessmentType] || labels.completa} · ${vacancy.title}`,
    durationMinutes: Math.min(90, Math.max(10, selectedQuestions.length * 4)),
    questions: selectedQuestions,
    maxAutoScore: selectedQuestions.filter((question) => question.type === "single_choice").reduce((sum, question) => sum + question.points, 0),
    autoReviewCount: selectedQuestions.filter((question) => question.type === "written").length,
  };
}

module.exports = { generateAssessment };
