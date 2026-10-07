const path = require("path");
const WordExtractor = require("word-extractor");
const { PDFParse } = require("pdf-parse");

const wordExtractor = new WordExtractor();
const STOP_WORDS = new Set([
  "a", "al", "de", "del", "el", "en", "la", "las", "lo", "los", "por", "para",
  "con", "sin", "un", "una", "unos", "unas", "y", "e", "o", "u", "que", "se",
  "the", "and", "or", "of", "in", "for", "to", "with", "at", "from", "is", "are",
]);
const NON_NAME_HEADINGS = /^(curr[ií]culum(?: vitae)?|resume|cv|perfil(?: profesional)?|datos personales|datos de contacto|experiencia(?: profesional| laboral)?|educaci[oó]n|formaci[oó]n(?: acad[eé]mica)?|contacto|habilidades|competencias|objetivo(?: profesional)?|resumen|professional summary|professional profile|work experience|education|skills|contact|referencias)$/i;
const JOB_TITLE_WORDS = /(ingenier[oa]|analista|desarrollador|programador|coordinador|gerente|director|asistente|supervisor|contador|diseñador|abogad[oa]|arquitect[oa]|enfermer[oa]|m[eé]dic[oa]|t[eé]cnic[oa]|vendedor|consultor|especialista|administrador|auxiliar|jef[ea]|teacher|engineer|manager|developer|accountant)/i;

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 60000);
}

async function extractCvText(buffer, filename) {
  const extension = path.extname(filename || "").toLowerCase();
  if (extension === ".pdf") {
    let parser;
    try {
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return cleanText(result.text);
    } finally {
      if (parser) {
        try { await parser.destroy(); } catch {}
      }
    }
  }

  if (extension === ".doc" || extension === ".docx") {
    const document = await wordExtractor.extract(buffer);
    return cleanText(document.getBody());
  }

  throw new Error("Formato de CV no compatible para lectura automática.");
}

function cleanNameCandidate(value) {
  let candidate = String(value || "")
    .replace(/[|•].*$/, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, " ")
    .trim();

  candidate = candidate.replace(/^(?:(?:lic(?:enciado|enciada)?|ing(?:eniero|ingeniera)?|dr(?:a)?|c\.?p\.?|mba|sr(?:a)?)[.]?\s+)+/i, "");

  const roleMatch = candidate.match(JOB_TITLE_WORDS);
  if (roleMatch) candidate = candidate.slice(0, roleMatch.index).trim();

  return candidate.replace(/[,:;\-]+$/g, "").trim();
}

function extractNameFromFilename(filename) {
  const stem = path.basename(String(filename || ""), path.extname(String(filename || "")))
    .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, "$1 $2")
    .replace(/[\d_()-]+/g, " ")
    .replace(/^(?:cv|curr[ií]culum(?:\s+vitae)?|resume|hoja\s+de\s+vida)\s*/i, "")
    .replace(/\b(?:final|actualizado|actualizada|copia|nuevo|nueva|version)\b/gi, " ")
    .trim();
  const candidate = cleanNameCandidate(stem);
  const words = candidate.match(/[\p{L}][\p{L}'’\-]*/gu) || [];
  return words.length >= 2 && words.length <= 5 && candidate.length <= 70 ? candidate : "";
}

function extractCandidateData(text, filename = "") {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const topText = text.slice(0, 8000);
  const phoneMatches = [...topText.matchAll(/\+?\d[\d\s().-]{7,}\d/g)];
  const phone = phoneMatches
    .filter((match) => {
      const digitCount = match[0].replace(/\D/g, "").length;
      const context = topText.slice(Math.max(0, match.index - 32), match.index).toLowerCase();
      return digitCount >= 10 && digitCount <= 15 && !/(?:curp|rfc|nss|c[óo]digo\s+postal)\s*[:#-]?\s*$/i.test(context);
    })
    .sort((left, right) => {
      const labelScore = (match) => /(?:celular|tel[eé]fono|m[oó]vil|whats(?:app)?|phone)\s*[:#-]?\s*$/i
        .test(topText.slice(Math.max(0, match.index - 32), match.index)) ? 1 : 0;
      return labelScore(right) - labelScore(left);
    })[0]?.[0].trim() || "";

  const lines = topText.split("\n").map((line) => line.trim()).filter(Boolean);
  const labelledName = lines
    .map((line) => line.match(/^(?:nombre(?:\s+completo)?|name|candidato)\s*[:\-]\s*(.+)$/i)?.[1])
    .map(cleanNameCandidate)
    .find((candidate) => {
      const words = candidate.match(/[\p{L}][\p{L}'’\-]*/gu) || [];
      return words.length >= 2 && words.length <= 5;
    });
  const filenameName = extractNameFromFilename(filename);
  const textName = lines.map(cleanNameCandidate).find((candidate) => {
    const words = candidate.match(/[\p{L}][\p{L}'’\-]*/gu) || [];
    return candidate.length <= 70
      && words.length >= 2
      && words.length <= 5
      && !NON_NAME_HEADINGS.test(candidate)
      && /^[\p{L}\s.'’\-]+$/u.test(candidate);
  }) || "";
  const nameLine = labelledName || filenameName || textName;

  const nameWords = nameLine.match(/[\p{L}][\p{L}'’\-]*/gu) || [];
  const lowerCaseParticles = new Set(["de", "del", "la", "las", "los", "y", "da", "dos", "van", "von"]);
  const formattedName = nameWords.map((word, index) => {
    const lower = word.toLocaleLowerCase("es-MX");
    if (index > 0 && lowerCaseParticles.has(lower)) return lower;
    return lower.charAt(0).toLocaleUpperCase("es-MX") + lower.slice(1);
  });
  return {
    first_name: formattedName[0] || "",
    last_name: formattedName.slice(1).join(" "),
    email,
    phone,
  };
}

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitRequirements(requirements) {
  return [...new Set(String(requirements || "")
    .replace(/(?:^|\n)\s*(?:[-*•]+|\d+[.)])\s*/g, "\n")
    .split(/[\n;,•]+/)
    .map((item) => item.replace(/^\s*(?:requisitos?|deseable)\s*:?\s*/i, "").trim())
    .filter((item) => item.length >= 3 && item.length <= 180))].slice(0, 100);
}

function evaluateCvAgainstRequirements(text, requirements) {
  if (!text.trim()) {
    return {
      available: false,
      coveragePercent: null,
      summary: "No fue posible medir la cobertura textual porque no se pudo extraer texto del CV.",
      reason: "No se pudo extraer texto del CV. Revisa el archivo y captura los datos manualmente.",
      matched: [],
      notFound: [],
      note: "La falta de texto detectable no indica que la persona carezca de experiencia.",
    };
  }

  const criteria = splitRequirements(requirements);
  if (criteria.length === 0) {
    return {
      available: false,
      coveragePercent: null,
      summary: "No hay requisitos explícitos en la vacante para comparar con el CV.",
      reason: "Agrega requisitos a la vacante para comparar el texto del CV.",
      matched: [],
      notFound: [],
      note: "La evaluación solo señala términos localizados en el documento.",
    };
  }

  const normalizedText = normalizeForMatch(text);
  const textTerms = new Set(normalizedText.split(" "));
  const textLines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const matched = [];
  const notFound = [];
  const partial = [];

  for (const requirement of criteria) {
    const normalizedRequirement = normalizeForMatch(requirement);
    const terms = [...new Set(normalizedRequirement.split(" ").filter((term) =>
      term.length > 2 && !STOP_WORDS.has(term)
    ))];
    const foundTerms = terms.filter((term) => textTerms.has(term));
    const isFullMatch = normalizedText.includes(normalizedRequirement);
    const isMatched = isFullMatch
      || (terms.length > 0 && foundTerms.length >= Math.ceil(terms.length * 0.7));

    if (isMatched) {
      const evidenceLines = textLines
        .map((line) => ({ line, normalized: normalizeForMatch(line) }))
        .filter(({ normalized }) => isFullMatch
          ? normalized.includes(normalizedRequirement)
          : foundTerms.some((term) => normalized.includes(term)))
        .sort((left, right) => {
          if (isFullMatch) return 0;
          const score = (normalized) => foundTerms.filter((term) => normalized.includes(term)).length;
          return score(right.normalized) - score(left.normalized);
        })
        .slice(0, 2)
        .map(({ line }) => line);
      const match = { requirement, evidence: evidenceLines.join(" … ").slice(0, 400), matchType: isFullMatch ? "frase" : "términos" };
      matched.push(match);
      if (!isFullMatch) partial.push(requirement);
    } else {
      notFound.push(requirement);
    }
  }

  const coveragePercent = Math.round((matched.length / criteria.length) * 100);
  const summary = `Se localizó evidencia textual para ${matched.length} de ${criteria.length} criterios de la vacante (${coveragePercent}% de cobertura). ${notFound.length ? `${notFound.length} criterio(s) no se localizaron en el texto extraído.` : "Todos los criterios definidos tienen alguna evidencia textual localizada."} ${partial.length ? `${partial.length} coincidencia(s) son parciales y requieren revisión del fragmento.` : ""}`.trim();

  return {
    available: true,
    coveragePercent,
    criteriaCount: criteria.length,
    matchedCount: matched.length,
    notFoundCount: notFound.length,
    partialCount: partial.length,
    summary,
    matched,
    notFound,
    note: "El porcentaje mide únicamente la presencia de evidencia textual para los requisitos escritos en la vacante; no es una calificación de la persona ni mide su idoneidad. La extracción puede omitir texto en imágenes, tablas, sinónimos o archivos escaneados. Revisa el CV completo y confirma el contexto antes de decidir.",
    evaluated_at: new Date().toISOString(),
  };
}

module.exports = {
  extractCvText,
  extractCandidateData,
  evaluateCvAgainstRequirements,
  normalizeForMatch,
  splitRequirements,
};
