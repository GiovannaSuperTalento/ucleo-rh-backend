const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const pool = require("../db");

const docsDir = path.join(__dirname, "..", "generated-docs");
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!["image/png", "image/jpeg"].includes(file.mimetype)) return callback(new Error("El logo debe ser PNG o JPG."));
    callback(null, true);
  },
});

// 🟢 PLANTILLAS REGISTRADAS
const TEMPLATES = [
  { id: "constancia_laboral", name: "Constancia Laboral" },
  { id: "carta_recomendacion", name: "Carta de Recomendación" },
  { id: "carta_guarderia", name: "Carta para Guardería (IMSS)" },
  { id: "carta_probatoria_domicilio", name: "Carta Probatoria de Domicilio (IMSS)" },
  { id: "acta_administrativa", name: "Acta Administrativa (Mala Actuación)" },
  { id: "formato_multiple", name: "Formato Múltiple de Solicitudes" }
];

const TEMPLATE_TITLES = {
  constancia_laboral: "CONSTANCIA LABORAL",
  carta_recomendacion: "CARTA DE RECOMENDACIÓN",
  carta_guarderia: "CARTA DE ACREDITACIÓN PARA GUARDERÍA IMSS",
  carta_probatoria_domicilio: "CARTA PROBATORIA DE DOMICILIO PARA EL IMSS",
  acta_administrativa: "ACTA ADMINISTRATIVA DE HECHOS Y SANCIÓN DISCIPLINARIA",
  formato_multiple: "FORMATO MÚLTIPLE DE SOLICITUDES",
};

let customTemplatesReady;
async function ensureCustomTemplatesTable() {
  if (!customTemplatesReady) {
    customTemplatesReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS document_templates (
        id TEXT PRIMARY KEY,
        name VARCHAR(180) NOT NULL,
        title VARCHAR(240) NOT NULL,
        content TEXT NOT NULL,
        footer TEXT NOT NULL DEFAULT '',
        is_custom BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
      await pool.query("ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT TRUE");
      await pool.query("ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS company_id TEXT");
      await pool.query("ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS base_template_id TEXT");
      await pool.query("ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS include_logo BOOLEAN NOT NULL DEFAULT TRUE");
      await pool.query(`CREATE TABLE IF NOT EXISTS document_company_settings (
        company_id TEXT PRIMARY KEY,
        logo_data TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    })();
  }
  return customTemplatesReady;
}

function cleanText(value, maxLength = 12000) {
  return typeof value === "string" ? value.slice(0, maxLength).trim() : "";
}

function interpolateDocumentText(text, data) {
  return String(text || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    return value === null || value === undefined || value === "" ? "—" : String(value);
  });
}

function drawCompanyLogo(doc, company, enabled) {
  const logoData = enabled ? company?.document_logo_data : null;
  const match = typeof logoData === "string" ? logoData.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (!match) return false;
  try {
    doc.image(Buffer.from(match[2], "base64"), 58, 29, { fit: [70, 42], align: "center", valign: "center" });
    return true;
  } catch (error) {
    console.warn("No se pudo insertar el logo de la empresa en el PDF:", error.message);
    return false;
  }
}

function companyBuiltinId(companyId, templateId) {
  const key = crypto.createHash("sha256").update(`${companyId}:${templateId}`).digest("hex").slice(0, 24);
  return `company_${key}`;
}

async function buildCustomTemplatePDF(template, employeeId, overrides = {}) {
  const data = await fetchFullDetails(employeeId);
  if (!data) return null;
  const { emp, company } = data;
  const fullName = [emp.first_name, emp.last_name_paternal || emp.last_name, emp.last_name_maternal]
    .filter(Boolean).join(" ").trim();
  const today = new Date().toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });
  const fields = {
    nombre_completo: fullName,
    nombre: emp.first_name,
    apellido_paterno: emp.last_name_paternal || emp.last_name,
    apellido_materno: emp.last_name_maternal,
    puesto: emp.position,
    departamento: emp.department,
    empresa: company?.legal_name || company?.name || emp.company_name,
    rfc: emp.rfc,
    curp: emp.curp,
    nss: emp.nss,
    fecha_ingreso: emp.hire_date ? new Date(emp.hire_date).toLocaleDateString("es-MX") : "—",
    fecha: today,
    salario_mensual: emp.base_salary ? `$${Number(emp.base_salary).toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN` : "—",
    domicilio: [emp.street, emp.exterior_number, emp.neighborhood, emp.municipality, emp.state].filter(Boolean).join(", "),
  };
  const title = interpolateDocumentText(cleanText(overrides.title, 240) || template.title, fields);
  const body = interpolateDocumentText(cleanText(overrides.content, 12000) || template.content, fields);
  const footer = interpolateDocumentText(cleanText(overrides.footer, 1000), fields);
  const includeLogo = overrides.include_logo === undefined ? template.include_logo !== false : overrides.include_logo !== false;
  const filename = `doc_personalizado_${String(employeeId).replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.pdf`;
  const filePath = path.join(docsDir, filename);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 52, bottom: 82, left: 58, right: 58 } });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    const companyName = fields.empresa || "NÚCLEO RH";
    const drawFooter = () => {
      doc.save();
      doc.strokeColor("#E1E6E4").lineWidth(0.8).moveTo(58, 724).lineTo(554, 724).stroke();
      doc.fillColor("#5B6B6E").font("Helvetica").fontSize(8)
        .text(footer || `Documento emitido por ${companyName} vía Núcleo RH.`, 58, 734, { width: 496, align: "center", lineGap: 2 });
      doc.restore();
    };
    doc.on("pageAdded", drawFooter);
    doc.rect(0, 0, 612, 18).fill("#1B4B43");
    const logoShown = drawCompanyLogo(doc, company, includeLogo);
    const companyX = logoShown ? 145 : 58;
    const companyWidth = logoShown ? 409 : 496;
    doc.fillColor("#1B4B43").font("Helvetica-Bold").fontSize(14).text(String(companyName).toUpperCase(), companyX, 34, { width: companyWidth });
    doc.fillColor("#5B6B6E").font("Helvetica").fontSize(8).text(`Colaborador: ${fullName} · Puesto: ${emp.position || "—"}`, 58, 76, { width: 496 });
    doc.strokeColor("#E1E6E4").moveTo(58, 93).lineTo(554, 93).stroke();
    doc.fillColor("#1B2A2E").fontSize(9).text(`Fecha: ${today}`, 58, 100, { width: 496, align: "right" });
    doc.moveDown(2.2);
    doc.fillColor("#1B4B43").font("Helvetica-Bold").fontSize(15).text(title || template.name, { align: "center", width: 496 });
    doc.moveDown(1.5);
    doc.fillColor("#1B2A2E").font("Helvetica").fontSize(10.5);
    body.split(/\n\s*\n/).filter(Boolean).forEach((paragraph) => {
      doc.text(paragraph.trim(), { width: 496, align: "justify", lineGap: 4 });
      doc.moveDown(0.8);
    });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return { filename, file_url: `/generated-docs/${filename}`, employee: data.emp };
}

router.get("/templates", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    const companyId = req.query.company_id ? String(req.query.company_id) : null;
    const result = await pool.query(
      "SELECT id, name, title, content, footer, is_custom, company_id, base_template_id, include_logo FROM document_templates WHERE company_id IS NULL OR company_id = $1 ORDER BY created_at DESC",
      [companyId]
    );
    const saved = new Map(result.rows.map((row) => [row.id, row]));
    const builtins = TEMPLATES.map((template) => {
      const scopedId = companyId ? companyBuiltinId(companyId, template.id) : template.id;
      const override = saved.get(scopedId) || saved.get(template.id);
      return { ...template, id: override?.id || template.id, template_type_id: template.id, company_id: companyId, name: override?.name || template.name, title: override?.title || TEMPLATE_TITLES[template.id] || template.name, content: override?.content || "", footer: override?.footer || "", include_logo: override?.include_logo ?? true, is_custom: false };
    });
    const custom = result.rows.filter((row) => row.is_custom);
    res.json([...builtins, ...custom]);
  } catch (error) {
    res.status(500).json({ message: "No se pudieron cargar los formatos." });
  }
});

router.get("/company-logo/:companyId", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    const result = await pool.query("SELECT logo_data FROM document_company_settings WHERE company_id::text = $1::text", [req.params.companyId]);
    res.json({ logo_data: result.rows[0]?.logo_data || null });
  } catch (error) {
    res.status(500).json({ message: "No se pudo cargar el logo de la empresa." });
  }
});

router.post("/company-logo/:companyId", logoUpload.single("logo"), async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    if (!req.file) return res.status(400).json({ message: "Selecciona un logo PNG o JPG." });
    const logoData = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    await pool.query(
      `INSERT INTO document_company_settings (company_id, logo_data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (company_id) DO UPDATE SET logo_data = EXCLUDED.logo_data, updated_at = NOW()`,
      [String(req.params.companyId), logoData]
    );
    res.json({ logo_data: logoData });
  } catch (error) {
    res.status(500).json({ message: error.message || "No se pudo guardar el logo." });
  }
});

router.delete("/company-logo/:companyId", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    await pool.query("DELETE FROM document_company_settings WHERE company_id::text = $1::text", [req.params.companyId]);
    res.json({ message: "Logo eliminado." });
  } catch (error) {
    res.status(500).json({ message: "No se pudo eliminar el logo." });
  }
});

router.post("/templates", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    const name = cleanText(req.body.name, 180);
    const title = cleanText(req.body.title, 240);
    const content = cleanText(req.body.content, 12000);
    const footer = cleanText(req.body.footer, 1000);
    const companyId = req.body.company_id ? String(req.body.company_id) : null;
    const includeLogo = req.body.include_logo !== false;
    if (!name || !title || !content) return res.status(400).json({ message: "El nombre, título y contenido son obligatorios." });
    const id = `custom_${crypto.randomUUID()}`;
    const result = await pool.query(
      "INSERT INTO document_templates (id, name, title, content, footer, is_custom, company_id, include_logo) VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7) RETURNING id, name, title, content, footer, is_custom, company_id, include_logo",
      [id, name, title, content, footer, companyId, includeLogo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "No se pudo guardar el formato." });
  }
});

router.put("/templates/:id", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    const name = cleanText(req.body.name, 180);
    const title = cleanText(req.body.title, 240);
    const content = cleanText(req.body.content, 12000);
    const footer = cleanText(req.body.footer, 1000);
    const isCustom = req.params.id.startsWith("custom_");
    const baseTemplateId = req.body.base_template_id || (!isCustom ? req.params.id : null);
    const isBuiltin = TEMPLATES.some((template) => template.id === baseTemplateId);
    const companyId = req.body.company_id ? String(req.body.company_id) : null;
    const recordId = isBuiltin && companyId ? companyBuiltinId(companyId, baseTemplateId) : req.params.id;
    const includeLogo = req.body.include_logo !== false;
    if ((!isCustom && !isBuiltin) || !name || !title || (isCustom && !content)) return res.status(400).json({ message: "Revisa el nombre, título y contenido del formato." });
    const result = await pool.query(
      `INSERT INTO document_templates (id, name, title, content, footer, is_custom, company_id, base_template_id, include_logo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, title = EXCLUDED.title, content = EXCLUDED.content, footer = EXCLUDED.footer, is_custom = EXCLUDED.is_custom, company_id = EXCLUDED.company_id, base_template_id = EXCLUDED.base_template_id, include_logo = EXCLUDED.include_logo, updated_at = NOW()
       RETURNING id, name, title, content, footer, is_custom, company_id, base_template_id, include_logo`,
      [recordId, name, title, content, footer, isCustom, companyId, isBuiltin ? baseTemplateId : null, includeLogo]
    );
    if (!result.rows.length) return res.status(404).json({ message: "Formato no encontrado." });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "No se pudo actualizar el formato." });
  }
});

router.delete("/templates/:id", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    if (!req.params.id.startsWith("custom_")) return res.status(400).json({ message: "Este formato oficial no se puede eliminar." });
    await pool.query("DELETE FROM document_templates WHERE id = $1", [req.params.id]);
    res.json({ message: "Formato eliminado." });
  } catch (error) {
    res.status(500).json({ message: "No se pudo eliminar el formato." });
  }
});

router.post("/generate-custom", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    const { employee_id, template_id } = req.body;
    const result = await pool.query("SELECT * FROM document_templates WHERE id = $1", [template_id]);
    if (!result.rows.length) return res.status(404).json({ message: "Formato no encontrado." });
    const template = result.rows[0];
    const employeeDetails = await fetchFullDetails(employee_id);
    if (!employeeDetails) return res.status(404).json({ message: "Colaborador no encontrado." });
    if (template.company_id && String(template.company_id) !== String(employeeDetails.emp.company_id)) return res.status(403).json({ message: "Este formato pertenece a otra empresa." });
    const generated = await buildCustomTemplatePDF(template, employee_id, { ...req.body, include_logo: req.body.include_logo ?? template.include_logo });
    if (!generated) return res.status(404).json({ message: "Colaborador no encontrado." });
    await pool.query(
      "INSERT INTO employee_documents (employee_id, template_id, template_name, file_url, created_at) VALUES ($1, $2, $3, $4, NOW())",
      [generated.employee.id, template.id, template.name, generated.file_url]
    ).catch(() => {});
    res.json({ message: "Vista final generada.", file_url: generated.file_url, filename: generated.filename });
  } catch (error) {
    console.error("Error al generar formato personalizado:", error.message);
    res.status(500).json({ message: "No se pudo generar el PDF." });
  }
});

function buildCorporatePDF(docType, emp, company, manager, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const filename = `${options.preview ? "preview" : "doc"}_${docType}_${emp.id}_${Date.now()}.pdf`;
      const filePath = path.join(docsDir, filename);
      const writeStream = fs.createWriteStream(filePath);

      doc.pipe(writeStream);

      // --- DATOS REALES EXTRAÍDOS Y CONTACTO INSTITUCIONAL ---
      const companyName = company?.legal_name || company?.name || emp.company_name || "NÚCLEO RH S.A. DE C.V.";
      const companyRfc = company?.rfc || "NRH180512AAA";
      const companyAddress = company?.address || "Av. de las Industrias #1000";
      
      const companyImss = company?.imss_registry || company?.registro_patronal || emp.imss_registry || emp.registro_patronal || "E123456710";
      
      const companyPhone = options.company_phone || company?.phone || emp.company_phone || "33 2156 8832";
      const companyEmail = options.company_email || company?.email || emp.company_email || "avillegas@silexcorp.mx";

      const fullName = [emp.first_name, emp.last_name_paternal || emp.last_name, emp.last_name_maternal]
        .filter(Boolean)
        .join(" ")
        .trim();

      const managerName = manager 
        ? [manager.first_name, manager.last_name_paternal || manager.last_name, manager.last_name_maternal].filter(Boolean).join(" ").trim()
        : "DIRECCIÓN DE RECURSOS HUMANOS";

      const managerPosition = manager?.position || "Jefe Inmediato";

      const salaryFormatted = emp.base_salary 
        ? `$${Number(emp.base_salary).toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN` 
        : "—";

      const workScheduleStr = emp.work_schedule && emp.work_schedule.trim() !== "" 
        ? emp.work_schedule.trim() 
        : "un horario asignado de Lunes a Viernes de 09:00 a 18:00 horas";

      const optionsDate = { year: "numeric", month: "long", day: "numeric" };
      const hireDateStr = emp.hire_date ? new Date(emp.hire_date).toLocaleDateString("es-MX", optionsDate) : "—";
      const contractStartDateStr = emp.contract_start_date ? new Date(emp.contract_start_date).toLocaleDateString("es-MX", optionsDate) : hireDateStr;
      const todayStr = new Date().toLocaleDateString("es-MX", optionsDate);
      const includeLogo = options.include_logo !== false;

      // --- ENCABEZADO CORREGIDO (ESPACIADO DINÁMICO) ---
      doc.rect(0, 0, 612, 18).fill("#1B4B43");
      const logoShown = drawCompanyLogo(doc, company, includeLogo);
      const companyX = logoShown ? 145 : 50;
      const companyWidth = logoShown ? 417 : 512;

      doc
        .fillColor("#1B4B43")
        .fontSize(14)
        .font("Helvetica-Bold")
        .text(String(companyName).toUpperCase(), companyX, 32, { width: companyWidth, align: "left" });

      // Se imprime dirección con ajuste automático de posición Y
      doc
        .fillColor("#5B6B6E")
        .fontSize(8)
        .font("Helvetica")
        .text(`RFC: ${companyRfc} · ${companyAddress}`, companyX, doc.y + 2, { width: companyWidth, align: "left", lineGap: 1 });

      const headerBottomY = Math.max(doc.y + 6, logoShown ? 78 : 0);

      doc
        .lineWidth(1)
        .strokeColor("#E1E6E4")
        .moveTo(50, headerBottomY)
        .lineTo(562, headerBottomY)
        .stroke();

      doc
        .fillColor("#1B2A2E")
        .fontSize(8.5)
        .font("Helvetica")
        .text(`Guadalajara, Jalisco a ${todayStr}`, 50, headerBottomY + 8, { width: 512, align: "right" });

      // --- TÍTULO ---
      let title = "DOCUMENTO OFICIAL";
      if (docType === "constancia_laboral") title = "CONSTANCIA LABORAL";
      if (docType === "carta_recomendacion") title = "CARTA DE RECOMENDACIÓN";
      if (docType === "carta_guarderia") title = "CARTA DE ACREDITACIÓN PARA GUARDERÍA IMSS";
      if (docType === "carta_probatoria_domicilio") title = "CARTA PROBATORIA DE DOMICILIO PARA EL IMSS";
      if (docType === "acta_administrativa") title = "ACTA ADMINISTRATIVA DE HECHOS Y SANCIÓN DISCIPLINARIA";
      if (docType === "formato_multiple") title = "FORMATO MÚLTIPLE DE SOLICITUDES";
      if (options.title_override) title = options.title_override;

      doc.y = headerBottomY + 28;
      doc.fillColor("#1B4B43").fontSize(11.5).font("Helvetica-Bold").text(title, 50, doc.y, { width: 512, align: "center" });

      // --- CUADRO DEL TRABAJADOR ---
      const boxStart = doc.y + 12;
      doc.rect(50, boxStart, 512, 60).fillAndStroke("#F3F5F4", "#E1E6E4");

      doc
        .fillColor("#1B2A2E")
        .fontSize(8.5)
        .font("Helvetica-Bold").text("Colaborador: ", 60, boxStart + 8)
        .font("Helvetica").text(fullName, 125, boxStart + 8)
        .font("Helvetica-Bold").text("Puesto: ", 330, boxStart + 8)
        .font("Helvetica").text(emp.position || "Colaborador", 375, boxStart + 8);

      doc
        .font("Helvetica-Bold").text("CURP: ", 60, boxStart + 24)
        .font("Helvetica").text(emp.curp || "—", 125, boxStart + 24)
        .font("Helvetica-Bold").text("NSS: ", 330, boxStart + 24)
        .font("Helvetica").text(emp.nss || "—", 375, boxStart + 24);

      doc
        .font("Helvetica-Bold").text("RFC: ", 60, boxStart + 40)
        .font("Helvetica").text(emp.rfc || "—", 125, boxStart + 40)
        .font("Helvetica-Bold").text("Fecha de Alta: ", 330, boxStart + 40)
        .font("Helvetica").text(hireDateStr, 395, boxStart + 40);

      // --- CONTENIDO DEL DOCUMENTO ---
      doc.x = 50;
      doc.y = boxStart + 72;
      doc.fillColor("#1B2A2E").fontSize(9.5).font("Helvetica");

      const textOptions = { width: 512, align: "justify", lineGap: 3 };

      if (options.body_override && options.body_override.trim()) {
        const templateFields = {
          nombre_completo: fullName, nombre: emp.first_name, apellido_paterno: emp.last_name_paternal || emp.last_name,
          apellido_materno: emp.last_name_maternal, puesto: emp.position, departamento: emp.department,
          empresa: companyName, rfc: emp.rfc, curp: emp.curp, nss: emp.nss,
          fecha_ingreso: hireDateStr, fecha: todayStr, salario_mensual: salaryFormatted,
          domicilio: [emp.street, emp.exterior_number, emp.neighborhood, emp.municipality, emp.state].filter(Boolean).join(", "),
          nombre_hijo: options.child_name, fecha_hechos: options.incident_date, hora_hechos: options.incident_time,
          lugar_hechos: options.incident_location, observaciones: options.observaciones,
          testigo_1: options.witness1, testigo_2: options.witness2,
          opciones_seleccionadas: Array.isArray(options.checked_options) ? options.checked_options.join(", ") : "",
          fecha_solicitud: options.fecha_solicitud,
        };
        const customText = interpolateDocumentText(options.body_override, templateFields);
        customText.split(/\n\s*\n/).filter(Boolean).forEach((paragraph) => {
          doc.text(paragraph.trim(), textOptions);
          doc.moveDown(0.8);
        });
      } else if (docType === "constancia_laboral") {
        doc.font("Helvetica-Bold").text("A QUIEN CORRESPONDA:", { width: 512 });
        doc.moveDown(0.8);
        doc.font("Helvetica").text(
          `Por medio de la presente hacemos constar formalmente que el/la C. ${fullName}, con RFC ${emp.rfc || "N/A"} y CURP ${emp.curp || "N/A"}, presta sus servicios en ${companyName} desde el día ${hireDateStr}, desempeñando el puesto de ${emp.position || "Colaborador"} en el departamento de ${emp.department || "General"}.`,
          textOptions
        );
        doc.moveDown(0.8);
        doc.text(
          `Actualmente cumple con un horario de ${workScheduleStr} y percibe un salario neto mensual de ${salaryFormatted}, bajo un esquema de contratación de tipo ${emp.contract_type || "Indeterminado"}.`,
          textOptions
        );
        doc.moveDown(0.8);
        doc.text("Se extiende la presente constancia a solicitud del interesado para los fines legales y administrativos que al mismo convengan.", textOptions);

      } else if (docType === "carta_recomendacion") {
        doc.font("Helvetica-Bold").text("A QUIEN CORRESPONDA:", { width: 512 });
        doc.moveDown(0.8);
        doc.font("Helvetica").text(
          `Nos permitimos recomendar ampliamente al/la C. ${fullName}, quien colabora en ${companyName} desde el día ${hireDateStr} desempeñando las funciones de ${emp.position || "Colaborador"}.`,
          textOptions
        );
        doc.moveDown(0.8);
        doc.text(
          "Durante su permanencia ha demostrado aptitudes destacadas de honestidad, puntualidad y constante profesionalismo en las responsabilidades asignadas.",
          textOptions
        );
        doc.moveDown(0.8);
        doc.text("Otorgamos nuestra entera recomendación para los fines laborales o académicos que considere convenientes.", textOptions);

      } else if (docType === "carta_guarderia") {
        const childName = options.child_name && options.child_name.trim() !== "" ? options.child_name.trim() : "su hijo(a) menor de edad";

        doc.font("Helvetica-Bold").text("INSTITUTO MEXICANO DEL SEGURO SOCIAL (IMSS)", { width: 512 });
        doc.text("DELEGACIÓN DE GUARDERÍAS", { width: 512 });
        doc.moveDown(0.8);
        doc.font("Helvetica").text(
          `Se certifica que el/la trabajador(a) ${fullName}, afiliado(a) con NSS ${emp.nss || "N/A"}, labora activamente para la empresa ${companyName} cumpliendo con ${workScheduleStr}.`,
          textOptions
        );
        doc.moveDown(0.8);
        doc.text(
          `Registra una percepción salarial de ${salaryFormatted}. Se expide la presente para respaldar la solicitud e inscripción del/la menor ${childName.toUpperCase()} en el servicio de guardería del IMSS.`,
          textOptions
        );

      } else if (docType === "carta_probatoria_domicilio") {
        const calleExteriorInterior = `${emp.street || emp.fiscal_street || "—"} ${emp.exterior_number || emp.fiscal_exterior_number || ""}${emp.interior_number || emp.fiscal_interior_number ? " Int. " + (emp.interior_number || emp.fiscal_interior_number) : ""}`.trim();
        const coloniaStr = emp.neighborhood || emp.fiscal_neighborhood || "—";
        const municipioStr = emp.municipality || emp.fiscal_municipality || "—";
        const cpStr = emp.postal_code || emp.fiscal_postal_code || "—";
        const estadoStr = emp.state || emp.fiscal_state || "Jalisco";

        doc.font("Helvetica-Bold").text("A QUIEN CORRESPONDA", { width: 512 });
        doc.text("Presente", { width: 512 });
        doc.moveDown(0.8);

        doc.font("Helvetica").text(
          `Por medio de la presente, la empresa ${companyName}, con Registro Patronal ante el IMSS ${companyImss} y RFC ${companyRfc}, HAGO CONSTAR QUE:`,
          textOptions
        );
        doc.moveDown(0.8);

        doc.text(
          `El/la C. ${fullName}, con Número de Seguridad Social (NSS) ${emp.nss || "N/A"} y CURP ${emp.curp || "N/A"}, labora actualmente en esta empresa desde el ${contractStartDateStr}, desempeñando el puesto de ${emp.position || "Colaborador"}.`,
          textOptions
        );
        doc.moveDown(0.8);

        doc.text(
          `Asimismo, para los fines administrativos o de aclaración de domicilio que el interesado requiera ante este instituto, manifestamos que el colaborador labora/reside vinculado a nuestro centro de trabajo ubicado en:`,
          textOptions
        );
        doc.moveDown(0.6);

        // Lista viñetada del Domicilio
        const domX = 70;
        doc.font("Helvetica-Bold").text("• Calle y número: ", domX, doc.y, { continued: true }).font("Helvetica").text(calleExteriorInterior);
        doc.font("Helvetica-Bold").text("• Colonia: ", domX, doc.y + 4, { continued: true }).font("Helvetica").text(coloniaStr);
        doc.font("Helvetica-Bold").text("• Municipio / Alcaldía: ", domX, doc.y + 4, { continued: true }).font("Helvetica").text(municipioStr);
        doc.font("Helvetica-Bold").text("• Código Postal: ", domX, doc.y + 4, { continued: true }).font("Helvetica").text(cpStr);
        doc.font("Helvetica-Bold").text("• Estado: ", domX, doc.y + 4, { continued: true }).font("Helvetica").text(estadoStr);

        doc.moveDown(1);
        doc.x = 50;
        doc.font("Helvetica").text(
          `Se expide la presente a petición del interesado y para los usos legales y administrativos a que haya diera lugar ante el IMSS.`,
          textOptions
        );

      } else if (docType === "acta_administrativa") {
        const incidentDate = options.incident_date || todayStr;
        const incidentTime = options.incident_time || "10:00 hrs";
        
        const addressToUse = options.incident_location && options.incident_location !== "Instalaciones de la Empresa" && options.incident_location.trim() !== ""
          ? options.incident_location.trim()
          : (companyAddress || "el domicilio fiscal registrado de la empresa");

        const incidentDetails = options.observaciones && options.observaciones.trim() !== ""
          ? options.observaciones.trim()
          : "Incumplimiento de las directrices operativas y código de conducta de la empresa.";

        doc.font("Helvetica-Bold").text("HECHOS Y CIRCUNSTANCIAS:", { width: 512 });
        doc.moveDown(0.3);
        doc.font("Helvetica").text(
          `En las instalaciones de ${companyName}, ubicadas en ${addressToUse}, se asienta la presente Acta Administrativa de Hechos al/la C. ${fullName}, por los acontecimientos ocurridos el día ${incidentDate} a las ${incidentTime}, consistentes en:`,
          textOptions
        );
        doc.moveDown(0.5);

        const factsY = doc.y;
        doc.rect(50, factsY, 512, 52).fillAndStroke("#FFFFFF", "#C6793D");
        doc.fillColor("#1B2A2E").fontSize(9).font("Helvetica-Oblique")
          .text(`"${incidentDetails}"`, 58, factsY + 8, { width: 496, align: "justify" });

        doc.x = 50;
        doc.y = factsY + 60;
        doc.font("Helvetica-Bold").fontSize(9.5).text("FUNDAMENTACIÓN LEGAL:", { width: 512 });
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(9).text(
          `La conducta descrita contraviene directamente las obligaciones del trabajador dispuestas en el Artículo 134 (Fracciones IV y IX) relativas al desempeño del trabajo con la intensidad, cuidado y esmero apropiados y la observancia de las medidas preventivas e higiene, constituible como causa de rescisión o sanción disciplinaria conforme al Artículo 47 (Fracciones XI y XII) de la Ley Federal del Trabajo vigente y el Reglamento Interior de Trabajo.`,
          textOptions
        );

        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").fontSize(9.5).text("COMPROMISO DEL EMPLEADO:", { width: 512 });
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(9).text(
          `Yo, C. ${fullName}, reconozco los hechos aquí descritos y asumo formalmente el compromiso de corregir de manera inmediata mi desempeño y conducta laboral, obligándome a no volver a incurrir en este tipo de faltas o actividades en lo sucesivo, apercibido(a) de que en caso de reincidencia la empresa aplicará las sanciones disciplinarias o la rescisión laboral definitiva.`,
          textOptions
        );

      } else if (docType === "formato_multiple") {
        const reqDateStr = options.fecha_solicitud ? new Date(options.fecha_solicitud).toLocaleDateString("es-MX", optionsDate) : todayStr;

        // 1. Datos extendidos
        doc.font("Helvetica-Bold").fontSize(9.5).text("SELECCIÓN DE TRÁMITE O SOLICITUD:", { width: 512 });
        doc.moveDown(0.5);

        // 2. Opciones / Checkboxes del Formato Múltiple
        const ALL_OPTIONS = [
          "Amonestación o Sanción", "Vacaciones", "Requisición",
          "Falta Justificada", "Cambio de Puesto o Unidad", "Laboratorio",
          "Falta Injustificada", "Permiso con Goce", "Modificación de Sueldo",
          "Apoyo a Comedor", "Uniforme", "Permiso sin Goce",
          "Préstamo", "Otro"
        ];

        const selectedOptions = options.checked_options || [];
        let checkX = 60;
        let checkY = doc.y;
        const colWidth = 160;

        ALL_OPTIONS.forEach((optName, index) => {
          const isChecked = selectedOptions.includes(optName);

          doc.rect(checkX, checkY, 9, 9).strokeColor("#475569").stroke();
          if (isChecked) {
            doc.fillColor("#1B4B43").fontSize(8).font("Helvetica-Bold").text("X", checkX + 1.5, checkY + 0.5);
          }

          doc.fillColor("#1E293B").fontSize(8).font("Helvetica").text(optName, checkX + 14, checkY + 1);

          checkX += colWidth;
          if ((index + 1) % 3 === 0) {
            checkX = 60;
            checkY += 16;
          }
        });

        // 3. Cuadro de Observaciones
        doc.y = checkY + 15;
        doc.font("Helvetica-Bold").fontSize(9).text("OBSERVACIONES:", { width: 512 });
        doc.moveDown(0.3);

        const obsY = doc.y;
        doc.rect(50, obsY, 512, 50).fillAndStroke("#FFFFFF", "#E1E6E4");
        doc.fillColor("#1B2A2E").fontSize(8.5).font("Helvetica-Oblique")
          .text(options.observaciones || "Sin observaciones adicionales registradas.", 58, obsY + 8, { width: 496 });

        doc.y = obsY + 60;
      }

      // --- SECCIÓN DE FIRMAS (ALINEACIÓN DINÁMICA Y FLUJOS SIN ENCIMAR) ---
      if (docType === "acta_administrativa") {
        const witness1Name = options.witness1 && options.witness1.trim() !== "" ? options.witness1.trim() : "Representante de Recursos Humanos";
        const witness2Name = options.witness2 && options.witness2.trim() !== "" ? options.witness2.trim() : "Testigo de Asistencia";

        doc.y = Math.max(doc.y + 25, 540);
        const sigY1 = doc.y;

        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(70, sigY1).lineTo(250, sigY1).stroke();
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(330, sigY1).lineTo(510, sigY1).stroke();

        doc
          .fontSize(8.5)
          .font("Helvetica-Bold").text(managerName, 70, sigY1 + 5, { width: 180, align: "center" })
          .font("Helvetica").text(managerPosition, 70, sigY1 + 16, { width: 180, align: "center" })
          .font("Helvetica-Bold").text(fullName, 330, sigY1 + 5, { width: 180, align: "center" })
          .font("Helvetica").text("Firma de Conformidad del Empleado", 330, sigY1 + 16, { width: 180, align: "center" });

        const sigY2 = sigY1 + 55;
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(70, sigY2).lineTo(250, sigY2).stroke();
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(330, sigY2).lineTo(510, sigY2).stroke();

        doc
          .fontSize(8.5)
          .font("Helvetica-Bold").text(witness1Name, 70, sigY2 + 5, { width: 180, align: "center" })
          .font("Helvetica").text("Testigo 1", 70, sigY2 + 16, { width: 180, align: "center" })
          .font("Helvetica-Bold").text(witness2Name, 330, sigY2 + 5, { width: 180, align: "center" })
          .font("Helvetica").text("Testigo 2", 330, sigY2 + 16, { width: 180, align: "center" });

      } else if (docType === "formato_multiple") {
        doc.y = Math.max(doc.y + 20, 560);
        const sigY = doc.y;

        // Fila 1: Supervisor y Gerente
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(60, sigY).lineTo(230, sigY).stroke();
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(330, sigY).lineTo(500, sigY).stroke();

        doc.fontSize(8).font("Helvetica-Bold")
          .text("Supervisor o Encargado", 60, sigY + 4, { width: 170, align: "center" })
          .text("Gerente", 330, sigY + 4, { width: 170, align: "center" });

        doc.fontSize(7.5).font("Helvetica")
          .text("Nombre y Firma", 60, sigY + 14, { width: 170, align: "center" })
          .text("Nombre y Firma", 330, sigY + 14, { width: 170, align: "center" });

        // Fila 2: Recursos Humanos y Empleado
        const sigY2 = sigY + 45;
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(60, sigY2).lineTo(230, sigY2).stroke();
        doc.lineWidth(0.8).strokeColor("#1B2A2E").moveTo(330, sigY2).lineTo(500, sigY2).stroke();

        doc.fontSize(8).font("Helvetica-Bold")
          .text("Recursos Humanos", 60, sigY2 + 4, { width: 170, align: "center" })
          .text("Empleado", 330, sigY2 + 4, { width: 170, align: "center" });

        doc.fontSize(7.5).font("Helvetica")
          .text("Nombre y Firma", 60, sigY2 + 14, { width: 170, align: "center" })
          .text("Nombre y Firma", 330, sigY2 + 14, { width: 170, align: "center" });

      } else {
        doc.y = Math.max(doc.y + 35, 580);
        const sigY = doc.y;

        doc.lineWidth(1).strokeColor("#1B2A2E").moveTo(70, sigY).lineTo(250, sigY).stroke();
        doc.lineWidth(1).strokeColor("#1B2A2E").moveTo(330, sigY).lineTo(510, sigY).stroke();

        doc
          .fontSize(8.5)
          .font("Helvetica-Bold").text("Atentamente,", 50, sigY - 20);

        // Columna Izquierda: Recursos Humanos
        doc
          .fontSize(8.5)
          .font("Helvetica-Bold").text("Departamento de Recursos Humanos", 70, sigY + 8, { width: 180, align: "center" });
        
        // Razón Social de la empresa (calcula altura dinámica para evitar traslapes)
        doc
          .font("Helvetica").text(companyName, 70, doc.y + 2, { width: 180, align: "center" });

        // Contacto justo debajo de la razón social
        doc
          .font("Helvetica").text(`Contacto: ${companyPhone} | ${companyEmail}`, 60, doc.y + 3, { width: 200, align: "center" });

        // Columna Derecha: Empleado
        doc
          .fontSize(8.5)
          .font("Helvetica-Bold").text(fullName, 330, sigY + 8, { width: 180, align: "center" })
          .font("Helvetica").text("Firma del Colaborador", 330, sigY + 20, { width: 180, align: "center" });
      }

      const footerText = options.footer_override
        ? interpolateDocumentText(options.footer_override, { nombre_completo: fullName, empresa: companyName, fecha: todayStr })
        : `Emitido por ${companyName} vía Núcleo RH. Documento oficial PDF.`;
      doc.fontSize(7.5).fillColor("#5B6B6E").text(footerText, 50, 740, { width: 512, align: "center" });

      doc.end();

      writeStream.on("finish", () => resolve({ filename, file_url: `/generated-docs/${filename}` }));
      writeStream.on("error", err => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

// 🟢 SELECCIÓN COMPLETA DE DETALLES
async function fetchFullDetails(employeeId) {
  const empRes = await pool.query("SELECT * FROM employees WHERE id::text = $1::text", [String(employeeId)]);
  if (empRes.rows.length === 0) return null;
  const emp = empRes.rows[0];

  let company = null;
  if (emp.company_id) {
    const compRes = await pool.query("SELECT * FROM companies WHERE id::text = $1::text", [String(emp.company_id)]).catch(() => ({ rows: [] }));
    company = compRes.rows[0] || null;
    const logoRes = await pool.query("SELECT logo_data FROM document_company_settings WHERE company_id::text = $1::text", [String(emp.company_id)]).catch(() => ({ rows: [] }));
    if (company) company.document_logo_data = logoRes.rows[0]?.logo_data || null;
  }

  let manager = null;
  if (emp.manager_id) {
    const manRes = await pool.query("SELECT * FROM employees WHERE id::text = $1::text", [String(emp.manager_id)]).catch(() => ({ rows: [] }));
    manager = manRes.rows[0] || null;
  }

  return { emp, company, manager };
}

// 🟢 RUTAS DE GENERACIÓN
router.post("/preview", async (req, res) => {
  try {
    await ensureCustomTemplatesTable();
    const employeeId = req.body.employee_id || req.body.employeeId || req.body.id;
    const templateId = req.body.template_id || req.body.template || req.body.type;
    if (!TEMPLATES.some((template) => template.id === templateId)) {
      return res.status(400).json({ message: "Selecciona un formato predefinido válido." });
    }
    const data = await fetchFullDetails(employeeId);
    if (!data) return res.status(404).json({ message: "Empleado no encontrado." });
    const saved = await pool.query("SELECT title, content, footer, include_logo, company_id FROM document_templates WHERE id = $1", [req.body.template_record_id || templateId]).catch(() => ({ rows: [] }));
    const override = saved.rows[0] || {};
    if (override.company_id && String(override.company_id) !== String(data.emp.company_id)) return res.status(403).json({ message: "Este formato pertenece a otra empresa." });
    const generated = await buildCorporatePDF(templateId, data.emp, data.company, data.manager, {
      ...req.body,
      preview: true,
      title_override: req.body.title_override || override.title,
      body_override: req.body.body_override || override.content,
      footer_override: req.body.footer_override || override.footer,
      include_logo: req.body.include_logo ?? override.include_logo,
    });
    const previewPath = path.join(docsDir, generated.filename);
    const cleanupTimer = setTimeout(() => fs.unlink(previewPath, () => {}), 10 * 60 * 1000);
    cleanupTimer.unref?.();
    res.json({ file_url: generated.file_url, filename: generated.filename });
  } catch (error) {
    console.error("Error al preparar vista previa del documento:", error.message);
    res.status(500).json({ message: "No se pudo preparar la vista previa." });
  }
});

router.post("/generate", async (req, res) => {
  const employee_id = req.body.employee_id || req.body.employeeId || req.body.id;
  const template_id = req.body.template_id || req.body.template || req.body.type;
  
  const { 
    child_name, 
    incident_date, 
    incident_time, 
    incident_location, 
    observaciones, 
    witness1, 
    witness2,
    checked_options,
    fecha_solicitud,
    title_override,
    body_override,
    footer_override
  } = req.body;

  try {
    await ensureCustomTemplatesTable();
    const data = await fetchFullDetails(employee_id);
    if (!data) return res.status(404).json({ message: "Empleado no encontrado." });

    const templateRecordId = req.body.template_record_id || template_id;
    const templateRes = await pool.query("SELECT name, title, content, footer, include_logo, company_id FROM document_templates WHERE id = $1", [templateRecordId]).catch(() => ({ rows: [] }));
    const templateOverride = templateRes.rows[0] || {};
    if (templateOverride.company_id && String(templateOverride.company_id) !== String(data.emp.company_id)) return res.status(403).json({ message: "Este formato pertenece a otra empresa." });

    const generated = await buildCorporatePDF(
      template_id, 
      data.emp, 
      data.company, 
      data.manager, 
      { 
        child_name, 
        incident_date, 
        incident_time, 
        incident_location, 
        observaciones, 
        witness1, 
        witness2,
        checked_options,
        fecha_solicitud,
        title_override: title_override || templateOverride.title,
        body_override: body_override || templateOverride.content,
        footer_override: footer_override || templateOverride.footer,
        include_logo: req.body.include_logo ?? templateOverride.include_logo
      }
    );

    await pool.query(
      `INSERT INTO employee_documents (employee_id, template_id, template_name, file_url, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [data.emp.id, template_id, templateOverride.name || TEMPLATES.find(t => t.id === template_id)?.name || template_id, generated.file_url]
    ).catch(() => {});

    res.json({
      message: "Documento PDF generado exitosamente",
      file_url: generated.file_url,
      filename: generated.filename
    });
  } catch (err) {
    console.error("Error al generar PDF:", err);
    res.status(500).json({ message: "Error interno al generar el documento PDF." });
  }
});

router.post("/multi-form", async (req, res) => {
  const employee_id = req.body.employee_id || req.body.employeeId || req.body.id;
  const { checked_options, observaciones, fecha_solicitud } = req.body;

  try {
    const data = await fetchFullDetails(employee_id);
    if (!data) return res.status(404).json({ message: "Empleado no encontrado." });

    const generated = await buildCorporatePDF("formato_multiple", data.emp, data.company, data.manager, { checked_options, observaciones, fecha_solicitud });

    await pool.query(
      `INSERT INTO employee_documents (employee_id, template_id, template_name, file_url, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [data.emp.id, "formato_multiple", "Formato Múltiple de Solicitudes", generated.file_url]
    ).catch(() => {});

    res.json({
      message: "Formato múltiple PDF generado exitosamente",
      file_url: generated.file_url,
      filename: generated.filename
    });
  } catch (err) {
    console.error("Error al generar formato múltiple PDF:", err);
    res.status(500).json({ message: "Error interno al generar formato múltiple PDF." });
  }
});

router.get("/employee/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM employee_documents WHERE employee_id::text = $1::text ORDER BY created_at DESC",
      [String(id)]
    ).catch(() => ({ rows: [] }));

    res.json(result.rows || []);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
