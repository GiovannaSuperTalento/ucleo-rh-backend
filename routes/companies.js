// routes/companies.js
const express = require("express");
const pool = require("../db");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const archiver = require("archiver");

const router = express.Router();

// 🟢 CONFIGURACIÓN DE ALMACENAMIENTO DE PLANTILLAS EN /uploads
const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `company_template_${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

// MAPEA Y ESTANDARIZA PROPIEDADES DE EMPRESA Y SUS DEPARTAMENTOS
const mapCompanyData = (comp, departments = []) => {
  if (!comp) return null;
  const companyName = comp.legal_name || comp.name || "Empresa";
  const imssVal = comp.imss_registry || comp.registro_patronal || "";

  return {
    ...comp,
    id: String(comp.id),
    name: companyName,
    legal_name: comp.legal_name || companyName,
    legalName: comp.legal_name || companyName,
    rfc: comp.rfc || "",
    address: comp.address || "",
    imss_registry: imssVal,
    registro_patronal: imssVal,
    departments: departments
  };
};

function numeroALetras(num) {
  if (num === null || num === undefined || isNaN(num) || num === 0) return "CERO PESOS 00/100 M.N.";
  const valor = parseFloat(num);
  const enteros = Math.floor(valor);
  const centavos = Math.round((valor - enteros) * 100);
  const centavosTexto = String(centavos).padStart(2, "0");
  const unidades = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
  const decenas = ["", "DIEZ", "VEINTE", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
  const especiales = ["DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE"];
  const cientos = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

  function convertirGrupo(n) {
    let output = "";
    if (n === 100) return "CIEN";
    if (n > 100) { output += cientos[Math.floor(n / 100)] + " "; n %= 100; }
    if (n >= 10 && n <= 19) { output += especiales[n - 10] + " "; return output; }
    if (n >= 20) {
      output += decenas[Math.floor(n / 10)];
      if (n % 10 !== 0) output += " Y " + unidades[n % 10];
      output += " "; return output;
    }
    if (n > 0) output += unidades[n] + " ";
    return output;
  }

  function transformar(n) {
    if (n === 0) return "CERO";
    let texto = "";
    if (Math.floor(n / 1000000) > 0) {
      const mill = Math.floor(n / 1000000);
      texto += (mill === 1 ? "UN MILLÓN " : convertirGrupo(mill) + "MILLONES ");
      n %= 1000000;
    }
    if (Math.floor(n / 1000) > 0) {
      const miles = Math.floor(n / 1000);
      texto += (miles === 1 ? "MIL " : convertirGrupo(miles) + "MIL ");
      n %= 1000;
    }
    if (n > 0) texto += convertirGrupo(n);
    return texto.trim();
  }

  return `${transformar(enteros)} PESOS ${centavosTexto}/100 M.N.`;
}

function formatearFechaLarga(fechaStr) {
  if (!fechaStr) return "SIN REGISTRAR";
  const fecha = new Date(fechaStr);
  if (isNaN(fecha.getTime())) return String(fechaStr).toUpperCase();
  const meses = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
  return `${fecha.getUTCDate()} DE ${meses[fecha.getUTCMonth()]} DE ${fecha.getUTCFullYear()}`;
}

function calcularEdad(fechaNacimientoStr) {
  if (!fechaNacimientoStr) return "NO ESPECIFICADA";
  const nacimiento = new Date(fechaNacimientoStr);
  if (isNaN(nacimiento.getTime())) return "NO ESPECIFICADA";
  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getUTCFullYear();
  const mes = hoy.getMonth() - nacimiento.getUTCMonth();
  if (mes < 0 || (mes === 0 && hoy.getDate() < nacimiento.getUTCDate())) edad--;
  return `${edad} AÑOS`;
}

function expandirEstadoCivil(estado) {
  if (!estado) return "SOLTERO(A)";
  const clean = String(estado).trim().toUpperCase();
  const mapa = { SOL: "SOLTERO(A)", SOLTERO: "SOLTERO(A)", SOLTERA: "SOLTERO(A)", CAS: "CASADO(A)", VIU: "VIUDO(A)", DIV: "DIVORCIADO(A)", ULI: "UNIÓN LIBRE" };
  return mapa[clean] || clean;
}

// 1. OBTENER TODAS LAS EMPRESAS CON SUS DEPARTAMENTOS
router.get("/", async (req, res) => {
  try {
    const compResult = await pool.query("SELECT * FROM companies ORDER BY created_at DESC").catch(async () => {
      return await pool.query("SELECT * FROM companies");
    });
    
    const deptResult = await pool.query(
      "SELECT id::text, name, company_id::text FROM departments ORDER BY name ASC"
    ).catch(async () => {
      return await pool.query("SELECT id::text, name, company_id::text FROM company_departments ORDER BY name ASC").catch(() => ({ rows: [] }));
    });

    const formattedCompanies = compResult.rows.map(comp => {
      const companyDepts = deptResult.rows.filter(d => String(d.company_id).trim() === String(comp.id).trim());
      return mapCompanyData(comp, companyDepts);
    });

    res.json(formattedCompanies);
  } catch (err) {
    console.error("❌ Error al obtener empresas:", err.message);
    res.status(500).json({ message: "No se pudieron obtener las empresas." });
  }
});

// 2. CREAR UNA NUEVA EMPRESA
router.post("/", async (req, res) => {
  const { legal_name, name, legalName, rfc, address, imss_registry, registro_patronal, departments } = req.body;
  const officialLegalName = (legal_name || name || legalName || "").trim();
  const officialImssRegistry = (imss_registry || registro_patronal || "").trim() || null;

  if (!officialLegalName) {
    return res.status(400).json({ message: "El nombre legal de la empresa es obligatorio." });
  }

  try {
    const colRes = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'companies'"
    );
    const validCols = colRes.rows.map(r => r.column_name.toLowerCase());

    const fields = [];
    const values = [];

    if (validCols.includes("legal_name")) { fields.push("legal_name"); values.push(officialLegalName); }
    if (validCols.includes("name")) { fields.push("name"); values.push(officialLegalName); }

    if (validCols.includes("rfc")) { fields.push("rfc"); values.push(rfc ? rfc.trim().toUpperCase() : null); }
    if (validCols.includes("address")) { fields.push("address"); values.push(address ? address.trim() : null); }
    
    if (validCols.includes("imss_registry")) { fields.push("imss_registry"); values.push(officialImssRegistry); }
    if (validCols.includes("registro_patronal")) { fields.push("registro_patronal"); values.push(officialImssRegistry); }

    if (validCols.includes("created_at")) { fields.push("created_at"); values.push(new Date()); }

    const colNames = fields.join(", ");
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");

    const result = await pool.query(
      `INSERT INTO companies (${colNames}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    const createdCompany = result.rows[0];
    let insertedDepts = [];

    if (Array.isArray(departments) && departments.length > 0) {
      for (const dept of departments) {
        const deptName = typeof dept === "string" ? dept : dept.name;
        if (deptName && deptName.trim() !== "") {
          const dRes = await pool.query(
            "INSERT INTO departments (name, company_id, created_at) VALUES ($1, $2::text, NOW()) RETURNING id::text, name, company_id::text",
            [deptName.trim(), String(createdCompany.id)]
          ).catch(() => null);
          if (dRes && dRes.rows[0]) insertedDepts.push(dRes.rows[0]);
        }
      }
    }

    res.status(201).json(mapCompanyData(createdCompany, insertedDepts));
  } catch (err) {
    console.error("❌ Error al crear empresa:", err.message);
    res.status(500).json({ message: "No se pudo crear la empresa: " + err.message });
  }
});

// 3. EDITAR / ACTUALIZAR EMPRESA
const handleUpdateCompany = async (req, res) => {
  const { id } = req.params;
  const { legal_name, name, legalName, rfc, address, imss_registry, registro_patronal } = req.body;
  const officialLegalName = (legal_name || name || legalName || "").trim();
  const officialImssRegistry = (imss_registry || registro_patronal || "").trim() || null;

  if (!officialLegalName) {
    return res.status(400).json({ message: "El nombre legal de la empresa es obligatorio." });
  }

  try {
    const colRes = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'companies'"
    );
    const validCols = colRes.rows.map(r => r.column_name.toLowerCase());

    let updateQuery = "UPDATE companies SET ";
    const updates = [];
    const values = [];
    let idx = 1;

    if (validCols.includes("legal_name")) { updates.push(`legal_name = $${idx++}`); values.push(officialLegalName); }
    if (validCols.includes("name")) { updates.push(`name = $${idx++}`); values.push(officialLegalName); }
    if (validCols.includes("rfc")) { updates.push(`rfc = $${idx++}`); values.push(rfc ? rfc.trim().toUpperCase() : null); }
    if (validCols.includes("address")) { updates.push(`address = $${idx++}`); values.push(address ? address.trim() : null); }
    if (validCols.includes("imss_registry")) { updates.push(`imss_registry = $${idx++}`); values.push(officialImssRegistry); }
    if (validCols.includes("registro_patronal")) { updates.push(`registro_patronal = $${idx++}`); values.push(officialImssRegistry); }

    if (updates.length === 0) {
      return res.status(400).json({ message: "No hay campos válidos para actualizar." });
    }

    updateQuery += updates.join(", ") + ` WHERE id::text = $${idx}::text RETURNING *`;
    values.push(id);

    const result = await pool.query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Empresa no encontrada." });
    }

    const deptResult = await pool.query(
      "SELECT id::text, name, company_id::text FROM departments WHERE company_id::text = $1::text",
      [id]
    ).catch(() => ({ rows: [] }));

    res.json(mapCompanyData(result.rows[0], deptResult.rows));
  } catch (err) {
    console.error(`❌ Error al actualizar empresa ${id}:`, err.message);
    res.status(500).json({ message: "No se pudo actualizar la empresa: " + err.message });
  }
};

router.put("/:id", handleUpdateCompany);
router.patch("/:id", handleUpdateCompany);

// 4. ELIMINAR EMPRESA
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const safeQuery = async (queryText, params) => {
      try { await pool.query(queryText, params); } catch (e) {}
    };

    await safeQuery("UPDATE employees SET company_id = NULL WHERE company_id::text = $1::text", [id]);
    await safeQuery("UPDATE companies SET parent_company_id = NULL WHERE parent_company_id::text = $1::text", [id]);
    await safeQuery(`DELETE FROM positions WHERE department_id::text IN (SELECT id::text FROM departments WHERE company_id::text = $1::text)`, [id]);
    await safeQuery("DELETE FROM branches WHERE company_id::text = $1::text", [id]);
    await safeQuery("DELETE FROM departments WHERE company_id::text = $1::text", [id]);
    await safeQuery("DELETE FROM company_departments WHERE company_id::text = $1::text", [id]);

    const result = await pool.query(
      "DELETE FROM companies WHERE id::text = $1::text RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Empresa no encontrada." });
    }

    res.json({ message: "Empresa eliminada exitosamente." });
  } catch (err) {
    console.error(`❌ Error al eliminar empresa ${id}:`, err.message);
    res.status(500).json({ message: "No se pudo eliminar la empresa: " + err.message });
  }
});

// 5. AGREGAR DEPARTAMENTO (CON SOPORTE PARA TEXT/UUID EN COMPANY_ID)
router.post("/:id/departments", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "El nombre del departamento es obligatorio." });
  }

  try {
    const result = await pool.query(
      "INSERT INTO departments (name, company_id, created_at) VALUES ($1, $2::text, NOW()) RETURNING id::text, name, company_id::text",
      [name.trim(), String(id)]
    ).catch(async () => {
      return await pool.query(
        "INSERT INTO company_departments (name, company_id) VALUES ($1, $2::text) RETURNING id::text, name, company_id::text",
        [name.trim(), String(id)]
      );
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`❌ Error al crear departamento para empresa ${id}:`, err.message);
    res.status(500).json({ message: "No se pudo agregar el departamento: " + err.message });
  }
});

// 6. ELIMINAR DEPARTAMENTO
router.delete("/departments/:deptId", async (req, res) => {
  const { deptId } = req.params;

  try {
    try {
      await pool.query("DELETE FROM positions WHERE department_id::text = $1::text", [deptId]);
    } catch (e) {}

    await pool.query("DELETE FROM departments WHERE id::text = $1::text", [deptId]).catch(async () => {
      await pool.query("DELETE FROM company_departments WHERE id::text = $1::text", [deptId]);
    });

    res.json({ message: "Departamento eliminado exitosamente." });
  } catch (err) {
    console.error(`❌ Error al eliminar departamento ${deptId}:`, err.message);
    res.status(500).json({ message: "No se pudo eliminar el departamento." });
  }
});

// 7. GET /api/companies/:id/templates -> Listar plantillas de una empresa
router.get("/:id/templates", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM company_templates WHERE company_id::text = $1::text ORDER BY document_type ASC, sub_type ASC`,
      [id]
    ).catch(() => ({ rows: [] }));

    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// 8. POST /api/companies/:id/upload-template -> Subir/Reemplazar plantilla
router.post("/:id/upload-template", upload.single("template"), async (req, res) => {
  try {
    const { id } = req.params;
    const { document_type, sub_type } = req.body;

    if (!req.file || !document_type) {
      return res.status(400).json({ message: "Se requiere la plantilla (.docx) y el tipo de documento." });
    }

    const subTypeClean = sub_type ? sub_type.trim() : "General";
    const relUrl = `/uploads/${path.basename(req.file.path)}`;

    const result = await pool.query(
      `INSERT INTO company_templates (company_id, document_type, sub_type, file_name, file_url, created_at)
       VALUES ($1::text, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [String(id), document_type, subTypeClean, req.file.originalname, relUrl]
    );

    res.json({ message: `Plantilla para '${document_type} - ${subTypeClean}' guardada con éxito.`, template: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Error al guardar plantilla: " + err.message });
  }
});

// 9. POST /api/companies/:id/fill-template -> Rellenar la plantilla seleccionada por tipo y subtipo
router.post("/:id/fill-template", async (req, res) => {
  try {
    const { id } = req.params;
    const { document_type, sub_type, employee_id } = req.body;

    let queryStr = `SELECT * FROM company_templates WHERE company_id::text = $1::text AND document_type = $2`;
    let queryParams = [String(id), document_type];

    if (sub_type) {
      queryStr += ` AND sub_type = $3`;
      queryParams.push(sub_type);
    }

    const tmplRes = await pool.query(queryStr, queryParams);

    if (tmplRes.rows.length === 0) {
      return res.status(404).json({ message: `No hay una plantilla configurada para '${document_type}${sub_type ? ` - ${sub_type}` : ''}' en esta Razón Social.` });
    }

    const tmpl = tmplRes.rows[0];
    const tmplFilename = path.basename(tmpl.file_url);
    const tmplFilePath = path.join(uploadsDir, tmplFilename);

    if (!fs.existsSync(tmplFilePath)) {
      return res.status(404).json({ message: "El archivo físico de la plantilla no existe en el servidor." });
    }

    const empRes = await pool.query(
      `SELECT e.*, c.legal_name AS company_name, c.rfc AS company_rfc
       FROM employees e
       LEFT JOIN companies c ON c.id::text = e.company_id::text
       WHERE e.id::text = $1::text`,
      [employee_id]
    );

    if (empRes.rows.length === 0) {
      return res.status(404).json({ message: "Empleado no encontrado." });
    }

    const e = empRes.rows[0];

    const salarioDiarioNum = parseFloat(e.base_daily_salary || (e.base_salary ? (e.base_salary / 30) : 0)) || 0;
    const salarioMensualNum = parseFloat(e.base_salary || (e.base_daily_salary ? (e.base_daily_salary * 30) : 0)) || 0;
    const salarioSdiNum = parseFloat(e.sdi_salary || salarioDiarioNum) || 0;

    const salarioDiarioTexto = numeroALetras(salarioDiarioNum).toUpperCase();
    const salarioMensualTexto = numeroALetras(salarioMensualNum).toUpperCase();

    const fechaIngresoFormateada = formatearFechaLarga(e.hire_date || e.contract_start_date);

    const nombreBeneficiarioClean = (e.beneficiary_name && String(e.beneficiary_name).trim() !== "" && String(e.beneficiary_name).toLowerCase() !== "null" && String(e.beneficiary_name).toLowerCase() !== "undefined")
      ? String(e.beneficiary_name).trim()
      : "SIN REGISTRAR";

    const rawActividades = (e.job_activities && String(e.job_activities).trim() !== "" && String(e.job_activities).toLowerCase() !== "null" && String(e.job_activities).toLowerCase() !== "undefined")
      ? String(e.job_activities).trim()
      : "Las indicadas por la Dirección General y correspondientes a su puesto.";

    const lineasActividades = rawActividades
      .split(/(?:\r?\n|\.\s+)+/)
      .map(act => {
        let clean = act.trim().replace(/\.$/, "");
        if (clean.length === 0) return "";
        return clean.charAt(0).toUpperCase() + clean.slice(1);
      })
      .filter(act => act.length > 2);

    const actividadesArray = lineasActividades.map(act => ({
      actividad: `${act}.`,
      ACTIVIDAD: `${act}.`
    }));

    const actividadesFormateadasTexto = lineasActividades.length > 0
      ? lineasActividades.map(item => `• ${item}.`).join("\n")
      : rawActividades;

    const rawData = {
      nombre_completo: `${e.first_name || ""} ${e.last_name_paternal || e.last_name || ""} ${e.last_name_maternal || ""}`.trim(),
      nombre: e.first_name || "",
      first_name: e.first_name || "",
      apellido_paterno: e.last_name_paternal || e.last_name || "",
      apellido_materno: e.last_name_maternal || "",
      nss: e.nss || "SIN REGISTRAR",
      numero_seguro_social: e.nss || "SIN REGISTRAR",
      curp: e.curp || "SIN REGISTRAR",
      rfc: e.rfc || "SIN REGISTRAR",
      fecha_nacimiento: formatearFechaLarga(e.birth_date),
      edad: calcularEdad(e.birth_date),
      estado_civil: expandirEstadoCivil(e.marital_status),
      genero: e.gender || "NO ESPECIFICADO",
      nacionalidad: e.nationality || "MEXICANA",
      domicilio_personal: `${e.street || ""} #${e.exterior_number || ""} ${e.interior_number ? `INT. ${e.interior_number}` : ""}, COL. ${e.neighborhood || ""}, CP ${e.postal_code || ""}, ${e.municipality || ""}, ${e.state || ""}`.trim(),
      domicilio_fiscal: `${e.fiscal_street || e.street || ""} #${e.fiscal_exterior_number || e.exterior_number || ""} ${e.fiscal_interior_number ? `INT. ${e.fiscal_interior_number}` : ""}, COL. ${e.fiscal_neighborhood || e.neighborhood || ""}, CP ${e.fiscal_postal_code || e.postal_code || ""}, ${e.fiscal_municipality || e.municipality || ""}, ${e.fiscal_state || e.state || ""}`.trim(),
      
      salario_diario: `$${salarioDiarioNum.toFixed(2)} MXN`,
      salario_diario_num: salarioDiarioNum.toFixed(2),
      salario_diario_letra: salarioDiarioTexto,
      salario_diario_escrito: salarioDiarioTexto,

      salario_mensual: `$${salarioMensualNum.toFixed(2)} MXN`,
      salario_mensual_num: salarioMensualNum.toFixed(2),
      salario_mensual_letra: salarioMensualTexto,
      salario_mensual_escrito: salarioMensualTexto,
      salario_letra: salarioMensualTexto,
      salario_escrito: salarioMensualTexto,

      salario_diario_integrado: `$${salarioSdiNum.toFixed(2)} MXN`,

      beneficiario: nombreBeneficiarioClean,
      nombre_beneficiario: nombreBeneficiarioClean,
      beneficiario_nombre: nombreBeneficiarioClean,
      beneficiary_name: nombreBeneficiarioClean,

      parentesco_beneficiario: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
      parentesco: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
      beneficiary_relationship: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
      relacion_beneficiario: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
      telefono_beneficiario: e.beneficiary_phone || "SIN TELÉFONO",

      contacto_emergencia: e.emergency_contact_name || "SIN REGISTRAR",
      relacion_emergencia: e.emergency_contact_relationship || "FAMILIAR",
      telefono_emergencia: e.emergency_contact_phone || "SIN TELÉFONO",

      empresa: e.company_name || "EMPRESA NO ASIGNADA",
      departamento: e.department || "GENERAL",
      puesto: e.position || "COLABORADOR",
      actividades_puesto: actividadesFormateadasTexto,
      actividades: actividadesFormateadasTexto,
      job_activities: actividadesFormateadasTexto,
      lista_actividades: actividadesArray,
      LISTA_ACTIVIDADES: actividadesArray,
      actividades_lista: actividadesArray,
      ACTIVIDADES_LISTA: actividadesArray,

      horario_laboral: e.work_schedule || "LUNES A VIERNES DE 09:00 A 18:00 HRS",
      tipo_contrato: e.contract_type || "INDETERMINADO",
      fecha_ingreso: fechaIngresoFormateada,
      fecha_alta: fechaIngresoFormateada,
      hire_date: fechaIngresoFormateada,
      fecha_inicio_contrato: formatearFechaLarga(e.contract_start_date || e.hire_date),
      fecha_termino_contrato: e.contract_end_date ? formatearFechaLarga(e.contract_end_date) : "INDEFINIDO"
    };

    const data = {};
    Object.keys(rawData).forEach(key => {
      const val = rawData[key];
      if (key.includes("actividad") || key.includes("job_activities")) {
        data[key] = val;
      } else if (typeof val === "string") {
        data[key] = val.toUpperCase();
      } else {
        data[key] = val;
      }
    });

    const content = fs.readFileSync(tmplFilePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    doc.render(data);

    const buf = doc.getZip().generate({ type: "nodebuffer" });
    const fileLabel = `${document_type}_${tmpl.sub_type || ''}`;
    const outputFilename = `${fileLabel.replace(/[^a-zA-Z0-9_-]/g, "_")}_${e.first_name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.docx`;
    const finalPath = path.join(uploadsDir, outputFilename);
    fs.writeFileSync(finalPath, buf);

    const fileUrl = `/uploads/${outputFilename}`;

    await pool.query(
      `INSERT INTO employee_files (employee_id, file_name, file_url, file_type, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [employee_id, `${document_type}${tmpl.sub_type ? ` - ${tmpl.sub_type}` : ''}.docx`, fileUrl, document_type]
    ).catch(() => {});

    res.json({
      message: `Documento '${document_type}' generado con éxito.`,
      file_url: fileUrl,
      filename: outputFilename
    });

  } catch (err) {
    console.error("❌ Error al llenar plantilla de empresa:", err);
    res.status(500).json({ message: "Error al generar documento: " + err.message });
  }
});

// 10. POST /api/companies/:id/fill-template-batch -> GENERACIÓN MASIVA EN ZIP
router.post("/:id/fill-template-batch", async (req, res) => {
  try {
    const { id } = req.params;
    const { document_type, sub_type, department } = req.body;

    let queryTmpl = `SELECT * FROM company_templates WHERE company_id::text = $1::text AND document_type = $2`;
    let paramsTmpl = [String(id), document_type];

    if (sub_type) {
      queryTmpl += ` AND sub_type = $3`;
      paramsTmpl.push(sub_type);
    }

    const tmplRes = await pool.query(queryTmpl, paramsTmpl);

    if (tmplRes.rows.length === 0) {
      return res.status(404).json({ message: `No hay plantilla de '${document_type}${sub_type ? ` - ${sub_type}` : ''}' cargada para esta empresa.` });
    }

    const tmpl = tmplRes.rows[0];
    const tmplFilePath = path.join(uploadsDir, path.basename(tmpl.file_url));

    if (!fs.existsSync(tmplFilePath)) {
      return res.status(404).json({ message: "El archivo físico de la plantilla no existe en el servidor." });
    }

    let queryEmp = `
      SELECT e.*, c.legal_name AS company_name, c.rfc AS company_rfc
      FROM employees e
      LEFT JOIN companies c ON c.id::text = e.company_id::text
      WHERE TRIM(LOWER(e.company_id::text)) = TRIM(LOWER($1::text)) AND TRIM(LOWER(e.employment_status)) = 'activo'
    `;
    let paramsEmp = [String(id)];

    if (department && department !== "all" && department.trim() !== "") {
      queryEmp += ` AND TRIM(LOWER(e.department)) = TRIM(LOWER($2))`;
      paramsEmp.push(department);
    }

    const empRes = await pool.query(queryEmp, paramsEmp);

    if (empRes.rows.length === 0) {
      return res.status(404).json({ 
        message: `No se encontraron colaboradores activos registrados en esta empresa${department && department !== 'all' ? ` para el departamento '${department}'` : ''}.` 
      });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });

    const zipName = `Formatos_${document_type.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    archive.pipe(res);

    for (const e of empRes.rows) {
      const salarioDiarioNum = parseFloat(e.base_daily_salary || (e.base_salary ? (e.base_salary / 30) : 0)) || 0;
      const salarioMensualNum = parseFloat(e.base_salary || (e.base_daily_salary ? (e.base_daily_salary * 30) : 0)) || 0;
      const salarioSdiNum = parseFloat(e.sdi_salary || salarioDiarioNum) || 0;
      const fechaIngresoFormateada = formatearFechaLarga(e.hire_date || e.contract_start_date);

      const nombreBeneficiarioClean = (e.beneficiary_name && String(e.beneficiary_name).trim() !== "" && String(e.beneficiary_name).toLowerCase() !== "null" && String(e.beneficiary_name).toLowerCase() !== "undefined")
        ? String(e.beneficiary_name).trim()
        : "SIN REGISTRAR";

      const rawActividades = (e.job_activities && String(e.job_activities).trim() !== "" && String(e.job_activities).toLowerCase() !== "null" && String(e.job_activities).toLowerCase() !== "undefined")
        ? String(e.job_activities).trim()
        : "Las indicadas por la Dirección General y correspondientes a su puesto.";

      const lineasActividades = rawActividades
        .split(/(?:\r?\n|\.\s+)+/)
        .map(act => {
          let clean = act.trim().replace(/\.$/, "");
          if (clean.length === 0) return "";
          return clean.charAt(0).toUpperCase() + clean.slice(1);
        })
        .filter(act => act.length > 2);

      const actividadesArray = lineasActividades.map(act => ({
        actividad: `${act}.`,
        ACTIVIDAD: `${act}.`
      }));

      const actividadesFormateadasTexto = lineasActividades.length > 0
        ? lineasActividades.map(item => `• ${item}.`).join("\n")
        : rawActividades;

      const rawData = {
        nombre_completo: `${e.first_name || ""} ${e.last_name_paternal || e.last_name || ""} ${e.last_name_maternal || ""}`.trim(),
        nombre: e.first_name || "",
        first_name: e.first_name || "",
        apellido_paterno: e.last_name_paternal || e.last_name || "",
        apellido_materno: e.last_name_maternal || "",
        nss: e.nss || "SIN REGISTRAR",
        numero_seguro_social: e.nss || "SIN REGISTRAR",
        curp: e.curp || "SIN REGISTRAR",
        rfc: e.rfc || "SIN REGISTRAR",
        fecha_nacimiento: formatearFechaLarga(e.birth_date),
        edad: calcularEdad(e.birth_date),
        estado_civil: expandirEstadoCivil(e.marital_status),
        genero: e.gender || "NO ESPECIFICADO",
        nacionalidad: e.nationality || "MEXICANA",
        domicilio_personal: `${e.street || ""} #${e.exterior_number || ""} ${e.interior_number ? `INT. ${e.interior_number}` : ""}, COL. ${e.neighborhood || ""}, CP ${e.postal_code || ""}, ${e.municipality || ""}, ${e.state || ""}`.trim(),
        domicilio_fiscal: `${e.fiscal_street || e.street || ""} #${e.fiscal_exterior_number || e.exterior_number || ""} ${e.fiscal_interior_number ? `INT. ${e.fiscal_interior_number}` : ""}, COL. ${e.fiscal_neighborhood || e.neighborhood || ""}, CP ${e.fiscal_postal_code || e.postal_code || ""}, ${e.fiscal_municipality || e.municipality || ""}, ${e.fiscal_state || e.state || ""}`.trim(),
        
        salario_diario: `$${salarioDiarioNum.toFixed(2)} MXN`,
        salario_diario_num: salarioDiarioNum.toFixed(2),
        salario_diario_letra: numeroALetras(salarioDiarioNum).toUpperCase(),
        salario_diario_escrito: numeroALetras(salarioDiarioNum).toUpperCase(),

        salario_mensual: `$${salarioMensualNum.toFixed(2)} MXN`,
        salario_mensual_num: salarioMensualNum.toFixed(2),
        salario_mensual_letra: numeroALetras(salarioMensualNum).toUpperCase(),
        salario_mensual_escrito: numeroALetras(salarioMensualNum).toUpperCase(),
        salario_letra: numeroALetras(salarioMensualNum).toUpperCase(),
        salario_escrito: numeroALetras(salarioMensualNum).toUpperCase(),

        salario_diario_integrado: `$${salarioSdiNum.toFixed(2)} MXN`,

        beneficiario: nombreBeneficiarioClean,
        nombre_beneficiario: nombreBeneficiarioClean,
        beneficiario_nombre: nombreBeneficiarioClean,
        beneficiary_name: nombreBeneficiarioClean,

        parentesco_beneficiario: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
        parentesco: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
        beneficiary_relationship: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
        relacion_beneficiario: e.beneficiary_relationship || e.emergency_contact_relationship || "FAMILIAR",
        telefono_beneficiario: e.beneficiary_phone || "SIN TELÉFONO",

        empresa: e.company_name || "EMPRESA NO ASIGNADA",
        departamento: e.department || "GENERAL",
        puesto: e.position || "COLABORADOR",
        actividades_puesto: actividadesFormateadasTexto,
        actividades: actividadesFormateadasTexto,
        job_activities: actividadesFormateadasTexto,
        lista_actividades: actividadesArray,
        LISTA_ACTIVIDADES: actividadesArray,
        actividades_lista: actividadesArray,
        ACTIVIDADES_LISTA: actividadesArray,

        horario_laboral: e.work_schedule || "LUNES A VIERNES DE 09:00 A 18:00 HRS",
        tipo_contrato: e.contract_type || "INDETERMINADO",
        fecha_ingreso: fechaIngresoFormateada,
        fecha_alta: fechaIngresoFormateada,
        hire_date: fechaIngresoFormateada,
        fecha_inicio_contrato: formatearFechaLarga(e.contract_start_date || e.hire_date),
        fecha_termino_contrato: e.contract_end_date ? formatearFechaLarga(e.contract_end_date) : "INDEFINIDO"
      };

      const data = {};
      Object.keys(rawData).forEach(key => {
        const val = rawData[key];
        if (key.includes("actividad") || key.includes("job_activities")) {
          data[key] = val;
        } else if (typeof val === "string") {
          data[key] = val.toUpperCase();
        } else {
          data[key] = val;
        }
      });

      const content = fs.readFileSync(tmplFilePath, "binary");
      const zip = new PizZip(content);
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

      doc.render(data);

      const buf = doc.getZip().generate({ type: "nodebuffer" });
      const empFileName = `${document_type}_${(e.first_name + '_' + (e.last_name_paternal || e.last_name || '')).replace(/[^a-zA-Z0-9_-]/g, "_")}.docx`;

      archive.append(buf, { name: empFileName });
    }

    await archive.finalize();
  } catch (err) {
    console.error("❌ Error en generación masiva:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Error al generar formatos masivos: " + err.message });
    }
  }
});

// 11. DELETE /api/companies/templates/:templateId -> Eliminar una plantilla de empresa por ID
router.delete("/templates/:templateId", async (req, res) => {
  const { templateId } = req.params;
  try {
    const tmplRes = await pool.query(`SELECT * FROM company_templates WHERE id::text = $1::text`, [templateId]);
    if (tmplRes.rows.length === 0) {
      return res.status(404).json({ message: "Plantilla no encontrada." });
    }

    const tmpl = tmplRes.rows[0];
    const tmplFilename = path.basename(tmpl.file_url);
    const tmplFilePath = path.join(uploadsDir, tmplFilename);

    if (fs.existsSync(tmplFilePath)) {
      try { fs.unlinkSync(tmplFilePath); } catch (e) {}
    }

    await pool.query(`DELETE FROM company_templates WHERE id::text = $1::text`, [templateId]);
    res.json({ message: "Plantilla eliminada correctamente." });
  } catch (err) {
    console.error("❌ Error al eliminar plantilla de empresa:", err);
    res.status(500).json({ message: "Error al eliminar plantilla: " + err.message });
  }
});

module.exports = router;