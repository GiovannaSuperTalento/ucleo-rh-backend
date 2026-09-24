// routes/employees.js
const express = require("express");
const pool = require("../db");
const bcrypt = require("bcrypt");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const multer = require("multer");
const Workbook = require("exceljs");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

function capitalize(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function cleanHeader(str) {
  if (!str) return "";
  return String(str)
    .trim()
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function numeroALetras(num) {
  if (num === null || num === undefined || isNaN(num) || num === 0) return "Cero pesos 00/100 M.N.";

  const valor = parseFloat(num);
  const enteros = Math.floor(valor);
  const centavos = Math.round((valor - enteros) * 100);
  const centavosTexto = String(centavos).padStart(2, "0");

  const unidades = ["", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
  const decenas = ["", "diez", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
  const especiales = ["diez", "once", "doce", "trece", "catorce", "quince", "diecisiete", "diecisiete", "dieciocho", "diecinueve"];
  const cientos = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecentos"];

  function convertirGrupo(n) {
    let output = "";
    if (n === 100) return "cien";
    if (n > 100) {
      output += cientos[Math.floor(n / 100)] + " ";
      n %= 100;
    }
    if (n >= 10 && n <= 19) {
      output += especiales[n - 10] + " ";
      return output;
    }
    if (n >= 20) {
      output += decenas[Math.floor(n / 20)];
      if (n % 10 !== 0) output += " y " + unidades[n % 10];
      output += " ";
      return output;
    }
    if (n > 0) {
      output += unidades[n] + " ";
    }
    return output;
  }

  function transformar(n) {
    if (n === 0) return "cero";
    let texto = "";
    if (Math.floor(n / 1000000) > 0) {
      const mill = Math.floor(n / 1000000);
      texto += (mill === 1 ? "un millón " : convertirGrupo(mill) + "millones ");
      n %= 1000000;
    }
    if (Math.floor(n / 1000) > 0) {
      const miles = Math.floor(n / 1000);
      texto += (miles === 1 ? "mil " : convertirGrupo(miles) + "mil ");
      n %= 1000;
    }
    if (n > 0) {
      texto += convertirGrupo(n);
    }
    return texto.trim();
  }

  const textoEnteros = transformar(enteros);
  const resultado = textoEnteros.charAt(0).toUpperCase() + textoEnteros.slice(1);
  return `${resultado} pesos ${centavosTexto}/100 M.N.`;
}

function formatearFechaLarga(fechaStr) {
  if (!fechaStr) return "SIN REGISTRAR";
  const fecha = new Date(fechaStr);
  if (isNaN(fecha.getTime())) return String(fechaStr).toUpperCase();

  const meses = [
    "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
    "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"
  ];

  const dia = fecha.getUTCDate();
  const mes = meses[fecha.getUTCMonth()];
  const anio = fecha.getUTCFullYear();

  return `${dia} DE ${mes} DE ${anio}`;
}

function calcularEdad(fechaNacimientoStr) {
  if (!fechaNacimientoStr) return "NO ESPECIFICADA";
  const nacimiento = new Date(fechaNacimientoStr);
  if (isNaN(nacimiento.getTime())) return "NO ESPECIFICADA";

  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getUTCFullYear();
  const mes = hoy.getMonth() - nacimiento.getUTCMonth();

  if (mes < 0 || (mes === 0 && hoy.getDate() < nacimiento.getUTCDate())) {
    edad--;
  }

  return `${edad} AÑOS`;
}

function expandirEstadoCivil(estado) {
  if (!estado) return "SOLTERO(A)";
  const clean = String(estado).trim().toUpperCase();

  const mapa = {
    SOL: "SOLTERO(A)",
    SOLTERO: "SOLTERO(A)",
    SOLTERA: "SOLTERO(A)",
    CAS: "CASADO(A)",
    CASADO: "CASADO(A)",
    CASADA: "CASADO(A)",
    VIU: "VIUDO(A)",
    DIV: "DIVORCIADO(A)",
    ULI: "UNIÓN LIBRE"
  };

  return mapa[clean] || clean;
}

// GET /api/employees -> Listar empleados con cast de UUIDs
router.get("/", async (req, res) => {
  const { search } = req.query;
  try {
    let query = `
      SELECT e.*, c.legal_name AS company_name
      FROM employees e
      LEFT JOIN companies c ON c.id::text = e.company_id::text
    `;
    const values = [];

    if (search && search.trim() !== "") {
      query += ` WHERE (
        LOWER(e.first_name || ' ' || COALESCE(e.last_name, '')) LIKE $1 OR
        LOWER(e.personal_email) LIKE $1 OR
        LOWER(COALESCE(e.curp, '')) LIKE $1 OR
        LOWER(COALESCE(e.rfc, '')) LIKE $1
      )`;
      values.push(`%${search.trim().toLowerCase()}%`);
    }

    query += ` ORDER BY e.created_at DESC`;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Error al obtener empleados:", err);
    res.status(500).json({ message: "Error interno al obtener empleados." });
  }
});

// GET /api/employees/me -> Obtener perfil propio
router.get("/me", async (req, res) => {
  try {
    const userEmail = req.user.email ? req.user.email.trim().toLowerCase() : "";

    const result = await pool.query(
      `SELECT e.*, c.legal_name AS company_name
       FROM employees e
       LEFT JOIN companies c ON c.id::text = e.company_id::text
       WHERE LOWER(e.personal_email) = $1`,
      [userEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No se encontró un expediente asociado a este usuario." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error al obtener el perfil propio:", err);
    res.status(500).json({ message: "Error al obtener la información de tu perfil." });
  }
});

// 🟢 CARGA MASIVA DE EXCEL CON MODO DIAGNÓSTICO Y BÚSQUEDA AUTOMÁTICA DE ENCABEZADO
router.post("/upload-excel", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No se seleccionó ningún archivo Excel." });
  }

  console.log(`\n========================================`);
  console.log(`📄 INICIANDO IMPORTACIÓN DE EXCEL: ${req.file.originalname}`);
  console.log(`========================================`);

  try {
    const workbook = new Workbook.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      throw new Error("El archivo Excel no contiene hojas de trabajo válidas.");
    }

    console.log(`📌 Hoja detectada: "${worksheet.name}" | Total filas detectadas: ${worksheet.rowCount}`);

    let insertedCount = 0;
    const errors = [];
    const rowsToProcess = [];

    const getCellText = (row, colNum) => {
      if (!row || colNum < 1) return "";
      const cell = row.getCell(colNum);
      if (!cell || cell.value === null || cell.value === undefined) return "";
      
      if (typeof cell.value === "object") {
        if (cell.value.result !== undefined) return String(cell.value.result).trim();
        if (cell.value.richText) return cell.value.richText.map(t => t.text).join("").trim();
        if (cell.value.text !== undefined) return String(cell.value.text).trim();
      }
      return String(cell.value).trim();
    };

    const parseExcelDate = (val) => {
      if (!val) return null;
      if (val instanceof Date) return val.toISOString().slice(0, 10);
      if (typeof val === "string") {
        const clean = val.trim();
        if (clean.includes("/")) {
          const parts = clean.split("/");
          if (parts.length === 3) {
            if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
          }
        }
        return clean.slice(0, 10);
      }
      return null;
    };

    // 🔍 1. Buscar en qué fila están realmente los encabezados
    let headerRowNumber = 1;
    let colMap = {
      first_name: -1, last_name_paternal: -1, last_name_maternal: -1, email: -1, position: -1, department: -1,
      hire_date: -1, curp: -1, rfc: -1, nss: -1, birth_date: -1, birth_place_municipality: -1, birth_place_state: -1,
      gender: -1, marital_status: -1, education_level: -1, last_grade: -1, street: -1, exterior_number: -1,
      interior_number: -1, neighborhood: -1, postal_code: -1, municipality: -1, state: -1, phone: -1, mobile_phone: -1,
      emergency_contact_name: -1, emergency_contact_relationship: -1, emergency_contact_phone: -1, payroll_type: -1,
      has_infonavit_credit: -1, infonavit_credit_number: -1, infonavit_discount_value: -1, bank_name: -1, bank_account: -1,
      bank_clabe: -1, contract_type: -1, contract_start_date: -1, contract_end_date: -1, base_daily_salary: -1, sdi_salary: -1
    };

    // Escanear las primeras 5 filas para encontrar la fila de títulos
    for (let r = 1; r <= Math.min(5, worksheet.rowCount); r++) {
      const candidateRow = worksheet.getRow(r);
      let foundHeaders = 0;

      candidateRow.eachCell({ includeEmpty: false }, (cell, colNum) => {
        const val = cleanHeader(getCellText(candidateRow, colNum));
        if (val.includes("NOMBRE") || val.includes("PATERNO") || val.includes("RFC") || val.includes("CURP") || val.includes("EMPRESA") || val.includes("PUESTO")) {
          foundHeaders++;
        }
      });

      if (foundHeaders >= 2) {
        headerRowNumber = r;
        console.log(`💡 Fila de encabezados identificada en la FILA ${headerRowNumber}`);
        break;
      }
    }

    const headerRow = worksheet.getRow(headerRowNumber);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const val = cleanHeader(getCellText(headerRow, colNum));

      if (val.includes("NOMBRE") && !val.includes("EMPRESA") && !val.includes("EMERG") && !val.includes("PADRE") && !val.includes("BENEF")) colMap.first_name = colNum;
      else if (val.includes("PATERNO") || val.includes("APATERNO")) colMap.last_name_paternal = colNum;
      else if (val.includes("MATERNO") || val.includes("AMATERNO")) colMap.last_name_maternal = colNum;
      else if (val.includes("CORREO") || val.includes("EMAIL") || val.includes("TRABAJADOR")) colMap.email = colNum;
      else if (val.includes("PUESTO")) colMap.position = colNum;
      else if (val.includes("DEPTO") || val.includes("DEPARTAMENTO")) colMap.department = colNum;
      else if (val.includes("ALTA") || val.includes("FDEALTA") || val.includes("FECHAALTA")) colMap.hire_date = colNum;
      else if (val.includes("CURP")) colMap.curp = colNum;
      else if (val.includes("RFC")) colMap.rfc = colNum;
      else if (val.includes("IMSS") || val.includes("NSS") || val.includes("SEGURO")) colMap.nss = colNum;
      else if (val.includes("FECHANAC") || val.includes("NACIMIENTO")) colMap.birth_date = colNum;
      else if (val.includes("LUGARNAC") || val.includes("MUNICIPIONAC")) colMap.birth_place_municipality = colNum;
      else if (val.includes("ESTADONAC")) colMap.birth_place_state = colNum;
      else if (val.includes("SEXO") || val.includes("GENERO")) colMap.gender = colNum;
      else if (val.includes("EDOCIVIL") || val.includes("ESTADOCIVIL")) colMap.marital_status = colNum;
      else if (val.includes("ESCOLARIDAD")) colMap.education_level = colNum;
      else if (val.includes("ULTIMOGRADO") || val.includes("GRADO")) colMap.last_grade = colNum;
      else if (val === "CALLE") colMap.street = colNum;
      else if (val.includes("EXTERIOR") || val.includes("NUMEROSIN") || val.includes("EXT")) colMap.exterior_number = colNum;
      else if (val.includes("INTERIOR") || val.includes("INT")) colMap.interior_number = colNum;
      else if (val.includes("COLONIA")) colMap.neighborhood = colNum;
      else if (val === "CP" || val.includes("POSTAL")) colMap.postal_code = colNum;
      else if (val === "MUNICIPIO") colMap.municipality = colNum;
      else if (val.includes("ESTADO") && !val.includes("NAC") && !val.includes("CIVIL")) colMap.state = colNum;
      else if (val.includes("TEL1") || val.includes("TELEFONO")) colMap.phone = colNum;
      else if (val.includes("CELULAR") || val.includes("MOVIL")) colMap.mobile_phone = colNum;
      else if (val.includes("CONTACTOEMERG") || val.includes("EMERGENCIA")) colMap.emergency_contact_name = colNum;
      else if (val.includes("RELACION") && val.includes("EMERG")) colMap.emergency_contact_relationship = colNum;
      else if (val.includes("TELEMERG")) colMap.emergency_contact_phone = colNum;
      else if (val.includes("NOMINA") || val.includes("TIPONOM")) colMap.payroll_type = colNum;
      else if (val.includes("INFONAVIT")) colMap.has_infonavit_credit = colNum;
      else if (val.includes("NUMCREDINFO") || val.includes("CREDITOINFO")) colMap.infonavit_credit_number = colNum;
      else if (val.includes("VALORDESCUENTO") || val.includes("DESCUENTO")) colMap.infonavit_discount_value = colNum;
      else if (val.includes("BANCO")) colMap.bank_name = colNum;
      else if (val.includes("CUENTA") && !val.includes("CLABE")) colMap.bank_account = colNum;
      else if (val.includes("CLABE")) colMap.bank_clabe = colNum;
      else if (val.includes("CONTRATO")) colMap.contract_type = colNum;
      else if (val.includes("INICIOCONTRATO")) colMap.contract_start_date = colNum;
      else if (val.includes("TERMINOCONTRATO")) colMap.contract_end_date = colNum;
      else if (val.includes("SDALTA") || val.includes("SALARIODIARIO")) colMap.base_daily_salary = colNum;
      else if (val.includes("SDIALTA") || val.includes("SDI")) colMap.sdi_salary = colNum;
    });

    console.log("🔍 Mapeo de columnas detectadas:", JSON.stringify(colMap, null, 2));

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return; // Saltar títulos

      let rawFirstName = colMap.first_name !== -1 ? getCellText(row, colMap.first_name) : getCellText(row, 3);
      let rawPaternal = colMap.last_name_paternal !== -1 ? getCellText(row, colMap.last_name_paternal) : getCellText(row, 4);
      let rawMaternal = colMap.last_name_maternal !== -1 ? getCellText(row, colMap.last_name_maternal) : getCellText(row, 5);

      // Si por alguna razón colMap no encontró la columna, intenta por posiciones de respaldo
      if (!rawFirstName && !rawPaternal) {
        rawFirstName = getCellText(row, 1) || getCellText(row, 2) || getCellText(row, 3);
        rawPaternal = getCellText(row, 4) || getCellText(row, 5);
      }

      const first_name = capitalize(rawFirstName);
      const last_name_paternal = capitalize(rawPaternal);
      const last_name_maternal = capitalize(rawMaternal);
      const last_name = [last_name_paternal, last_name_maternal].filter(Boolean).join(" ").trim() || last_name_paternal || "N/A";

      const personal_email = colMap.email !== -1 ? getCellText(row, colMap.email) : getCellText(row, 39);
      const position = capitalize(colMap.position !== -1 ? getCellText(row, colMap.position) : getCellText(row, 11));
      const department = capitalize(colMap.department !== -1 ? getCellText(row, colMap.department) : getCellText(row, 10));

      const rawCurp = colMap.curp !== -1 ? getCellText(row, colMap.curp) : getCellText(row, 6);
      const rawRfc = colMap.rfc !== -1 ? getCellText(row, colMap.rfc) : getCellText(row, 12);
      const rawNss = colMap.nss !== -1 ? getCellText(row, colMap.nss) : getCellText(row, 2);

      const curp = rawCurp ? rawCurp.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 18) : null;
      const rfc = rawRfc ? rawRfc.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 13) : null;
      const nss = rawNss ? rawNss.replace(/\D/g, "").slice(0, 11) : null;

      const birth_date = parseExcelDate(colMap.birth_date !== -1 ? row.getCell(colMap.birth_date).value : row.getCell(13).value);
      const birth_place_municipality = capitalize(colMap.birth_place_municipality !== -1 ? getCellText(row, colMap.birth_place_municipality) : getCellText(row, 14));
      const birth_place_state = (colMap.birth_place_state !== -1 ? getCellText(row, colMap.birth_place_state) : getCellText(row, 15)).toUpperCase();
      
      let rawGender = (colMap.gender !== -1 ? getCellText(row, colMap.gender) : getCellText(row, 16)).toUpperCase();
      const gender = rawGender.startsWith("M") && !rawGender.includes("FEM") ? "Masculino" : rawGender.startsWith("F") ? "Femenino" : rawGender;

      const marital_status = (colMap.marital_status !== -1 ? getCellText(row, colMap.marital_status) : getCellText(row, 17)).toUpperCase();
      const education_level = capitalize(colMap.education_level !== -1 ? getCellText(row, colMap.education_level) : getCellText(row, 18));
      const last_grade = capitalize(colMap.last_grade !== -1 ? getCellText(row, colMap.last_grade) : getCellText(row, 19));

      const street = capitalize(colMap.street !== -1 ? getCellText(row, colMap.street) : getCellText(row, 20));
      const exterior_number = colMap.exterior_number !== -1 ? getCellText(row, colMap.exterior_number) : getCellText(row, 21);
      const interior_number = colMap.interior_number !== -1 ? getCellText(row, colMap.interior_number) : getCellText(row, 22);
      const neighborhood = capitalize(colMap.neighborhood !== -1 ? getCellText(row, colMap.neighborhood) : getCellText(row, 23));
      const postal_code = colMap.postal_code !== -1 ? getCellText(row, colMap.postal_code) : getCellText(row, 24);
      const municipality = capitalize(colMap.municipality !== -1 ? getCellText(row, colMap.municipality) : getCellText(row, 25));
      const state = (colMap.state !== -1 ? getCellText(row, colMap.state) : getCellText(row, 26)).toUpperCase();

      const phone = colMap.phone !== -1 ? getCellText(row, colMap.phone) : getCellText(row, 27);
      const mobile_phone = colMap.mobile_phone !== -1 ? getCellText(row, colMap.mobile_phone) : getCellText(row, 28);

      const emergency_contact_name = capitalize(colMap.emergency_contact_name !== -1 ? getCellText(row, colMap.emergency_contact_name) : getCellText(row, 29));
      const emergency_contact_relationship = capitalize(colMap.emergency_contact_relationship !== -1 ? getCellText(row, colMap.emergency_contact_relationship) : getCellText(row, 30));
      const emergency_contact_phone = colMap.emergency_contact_phone !== -1 ? getCellText(row, colMap.emergency_contact_phone) : getCellText(row, 31);

      let rawPayroll = (colMap.payroll_type !== -1 ? getCellText(row, colMap.payroll_type) : getCellText(row, 32)).toUpperCase();
      const payroll_type = rawPayroll.includes("SEM") ? "SEM" : "QUI";

      const has_infonavit_credit = (colMap.has_infonavit_credit !== -1 ? getCellText(row, colMap.has_infonavit_credit) : getCellText(row, 33)).toUpperCase().includes("SI") ? "SI" : "NO";
      const infonavit_credit_number = colMap.infonavit_credit_number !== -1 ? getCellText(row, colMap.infonavit_credit_number) : getCellText(row, 34);
      const infonavit_discount_value = colMap.infonavit_discount_value !== -1 ? getCellText(row, colMap.infonavit_discount_value) : getCellText(row, 35);

      const bank_name = colMap.bank_name !== -1 ? getCellText(row, colMap.bank_name) : getCellText(row, 36);
      const bank_account = colMap.bank_account !== -1 ? getCellText(row, colMap.bank_account) : getCellText(row, 37);
      const bank_clabe = colMap.bank_clabe !== -1 ? getCellText(row, colMap.bank_clabe) : getCellText(row, 38);

      const contract_type = colMap.contract_type !== -1 ? getCellText(row, colMap.contract_type) : getCellText(row, 40);
      const contract_start_date = parseExcelDate(colMap.contract_start_date !== -1 ? row.getCell(colMap.contract_start_date).value : row.getCell(41).value);
      const contract_end_date = parseExcelDate(colMap.contract_end_date !== -1 ? row.getCell(colMap.contract_end_date).value : row.getCell(42).value);

      const base_daily_salary = colMap.base_daily_salary !== -1 ? getCellText(row, colMap.base_daily_salary) : getCellText(row, 7);
      const sdi_salary = colMap.sdi_salary !== -1 ? getCellText(row, colMap.sdi_salary) : getCellText(row, 8);

      let hire_date = parseExcelDate(colMap.hire_date !== -1 ? row.getCell(colMap.hire_date).value : row.getCell(9).value);

      const cleanTestStr = (first_name + " " + last_name_paternal).toUpperCase();
      const isHeaderRow = cleanTestStr.includes("NOMBRE") || cleanTestStr.includes("PATERNO") || cleanTestStr.includes("EMPRESA");

      if ((first_name || last_name_paternal || personal_email || curp || rfc) && !isHeaderRow) {
        rowsToProcess.push({
          first_name: first_name || "Colaborador",
          last_name_paternal: last_name_paternal || null,
          last_name_maternal: last_name_maternal || null,
          last_name,
          personal_email: personal_email || null,
          position: position || "Colaborador",
          department: department || "General",
          hire_date: hire_date || new Date().toISOString().slice(0, 10),
          curp, rfc, nss,
          birth_date, birth_place_municipality, birth_place_state, gender, marital_status,
          education_level, last_grade, street, exterior_number, interior_number, neighborhood,
          postal_code, municipality, state, phone, mobile_phone, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, payroll_type, has_infonavit_credit,
          infonavit_credit_number, infonavit_discount_value, bank_name, bank_account, bank_clabe,
          contract_type, contract_start_date, contract_end_date, base_daily_salary, sdi_salary
        });
      }
    });

    console.log(`📊 Total de filas procesables encontradas: ${rowsToProcess.length}`);

    const tableColsRes = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'employees'"
    );
    const validCols = tableColsRes.rows.map(r => r.column_name.toLowerCase());

    for (const emp of rowsToProcess) {
      try {
        const fields = ["first_name", "department", "hire_date", "employment_status", "created_at"];
        const values = [emp.first_name, emp.department, emp.hire_date, "activo", new Date()];

        const mapField = (fieldName, val) => {
          if (validCols.includes(fieldName) && val !== undefined && val !== null && val !== "") {
            fields.push(fieldName);
            values.push(val);
          }
        };

        mapField("last_name", emp.last_name);
        mapField("last_name_paternal", emp.last_name_paternal);
        mapField("last_name_maternal", emp.last_name_maternal);
        mapField("personal_email", emp.personal_email);
        mapField("position", emp.position);
        mapField("curp", emp.curp);
        mapField("rfc", emp.rfc);
        mapField("nss", emp.nss);
        mapField("birth_date", emp.birth_date);
        mapField("birth_place_municipality", emp.birth_place_municipality);
        mapField("birth_place_state", emp.birth_place_state);
        mapField("gender", emp.gender);
        mapField("marital_status", emp.marital_status);
        mapField("education_level", emp.education_level);
        mapField("last_grade", emp.last_grade);
        mapField("street", emp.street);
        mapField("exterior_number", emp.exterior_number);
        mapField("interior_number", emp.interior_number);
        mapField("neighborhood", emp.neighborhood);
        mapField("postal_code", emp.postal_code);
        mapField("municipality", emp.municipality);
        mapField("state", emp.state);
        mapField("phone", emp.phone);
        mapField("mobile_phone", emp.mobile_phone);
        mapField("emergency_contact_name", emp.emergency_contact_name);
        mapField("emergency_contact_relationship", emp.emergency_contact_relationship);
        mapField("emergency_contact_phone", emp.emergency_contact_phone);
        mapField("payroll_type", emp.payroll_type);
        mapField("has_infonavit_credit", emp.has_infonavit_credit);
        mapField("infonavit_credit_number", emp.infonavit_credit_number);
        mapField("infonavit_discount_value", emp.infonavit_discount_value);
        mapField("bank_name", emp.bank_name);
        mapField("bank_account", emp.bank_account);
        mapField("bank_clabe", emp.bank_clabe);
        mapField("contract_type", emp.contract_type);
        mapField("contract_start_date", emp.contract_start_date);
        mapField("contract_end_date", emp.contract_end_date);
        mapField("base_daily_salary", emp.base_daily_salary);
        mapField("sdi_salary", emp.sdi_salary);

        mapField("fiscal_street", emp.street);
        mapField("fiscal_exterior_number", emp.exterior_number);
        mapField("fiscal_interior_number", emp.interior_number);
        mapField("fiscal_neighborhood", emp.neighborhood);
        mapField("fiscal_postal_code", emp.postal_code);
        mapField("fiscal_municipality", emp.municipality);
        mapField("fiscal_state", emp.state);

        const colNames = fields.join(", ");
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");

        await pool.query(`INSERT INTO employees (${colNames}) VALUES (${placeholders})`, values);

        if (emp.personal_email && emp.personal_email.trim() !== "") {
          const emailClean = emp.personal_email.trim().toLowerCase();
          const userCheck = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1", [emailClean]);

          if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash("NucleoRH2026!", 10);
            await pool.query(
              `INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'empleado', true)`,
              [emailClean, hashedPassword]
            ).catch(() => {});
          }
        }

        insertedCount++;
      } catch (err) {
        console.error(`❌ Error al insertar fila (${emp.first_name}):`, err.message);
        errors.push(`Error en ${emp.first_name}: ${err.message}`);
      }
    }

    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    console.log(`✅ IMPORTACIÓN FINALIZADA: ${insertedCount} colaboradores agregados.`);

    res.json({
      message: `¡Carga masiva completada! Se registraron ${insertedCount} colaboradores correctamente.`,
      insertedCount,
      errors
    });
  } catch (err) {
    console.error("❌ Error general al procesar Excel de empleados:", err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: "No se pudo procesar el archivo Excel: " + err.message });
  }
});

// 🟢 CARGA RÁPIDA DE LOTE CON MAPEO EXPLÍCITO DE RANGOS
router.post("/:id/upload-batch-documents", upload.single("file"), async (req, res) => {
  const { id } = req.params;
  if (!req.file) {
    return res.status(400).json({ message: "No se seleccionó ningún archivo." });
  }

  try {
    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    if (fileExt !== ".pdf") {
      return res.status(400).json({ message: "El archivo a procesar debe ser un documento PDF." });
    }

    let mapping = {};
    if (req.body.mapping) {
      try {
        mapping = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
      } catch (e) {
        console.warn("⚠️ Mapeo en formato no válido, recurriendo al procedimiento por defecto.");
      }
    }

    const defaultDocTypes = [
      "Contrato Firmado",
      "Convenio de Confidencialidad",
      "Aviso de Privacidad",
      "Test de Integridad",
      "Políticas de RH",
      "Estado de Cuenta Bancaria",
      "Identificación Oficial (INE / Pasaporte)",
      "Comprobante de Domicilio",
      "Acta de Nacimiento",
      "CURP",
      "RFC (Constancia de Situación Fiscal)",
      "NSS (Número de Seguro Social)",
      "Comprobante de Estudios",
      "Carta de Recomendación",
      "Formatos Varios"
    ];

    const mainPdfBytes = fs.readFileSync(filePath);
    const mainPdfDoc = await PDFDocument.load(mainPdfBytes);
    const totalPages = mainPdfDoc.getPageCount();

    if (Object.keys(mapping).length === 0) {
      for (let i = 0; i < totalPages; i++) {
        const category = defaultDocTypes[i] || "Formatos Varios";
        if (!mapping[category]) mapping[category] = [];
        mapping[category].push(i);
      }
    }

    const uploadedDocs = [];

    for (const [docType, pageIndexes] of Object.entries(mapping)) {
      if (!Array.isArray(pageIndexes) || pageIndexes.length === 0) continue;

      const validIndexes = pageIndexes.filter(idx => typeof idx === "number" && idx >= 0 && idx < totalPages);
      if (validIndexes.length === 0) continue;

      const newPdfDoc = await PDFDocument.create();
      const copiedPages = await newPdfDoc.copyPages(mainPdfDoc, validIndexes);
      copiedPages.forEach(p => newPdfDoc.addPage(p));

      const newPdfBytes = await newPdfDoc.save();
      const uniqueName = `doc-${Date.now()}-${Math.round(Math.random() * 1000)}.pdf`;
      const finalPath = path.join(uploadsDir, uniqueName);

      fs.writeFileSync(finalPath, newPdfBytes);

      const relUrl = `/uploads/${uniqueName}`;

      await pool.query(
        `DELETE FROM employee_files WHERE employee_id::text = $1::text AND file_type = $2`,
        [id, docType]
      );

      const insRes = await pool.query(
        `INSERT INTO employee_files (employee_id, file_name, file_url, file_type, created_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [id, `${docType}.pdf`, relUrl, docType]
      );

      uploadedDocs.push(insRes.rows[0]);
    }

    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }

    res.json({
      message: `¡Documentos divididos e integrados al expediente correctamente!`,
      documents: uploadedDocs
    });
  } catch (err) {
    console.error("❌ Error al procesar PDF:", err);
    res.status(500).json({ message: "No se pudo procesar el archivo: " + err.message });
  }
});

// 🟢 MOVER DOCUMENTO SIN BORRAR LOS EXISTENTES EN LA CATEGORÍA DESTINO
router.put("/:id/files/:fileId/move", async (req, res) => {
  const { id, fileId } = req.params;
  const { targetType } = req.body;

  if (!targetType) {
    return res.status(400).json({ message: "Debes especificar la categoría de destino (targetType)." });
  }

  try {
    const result = await pool.query(
      `UPDATE employee_files 
       SET file_type = $1
       WHERE id::text = $2::text AND employee_id::text = $3::text
       RETURNING *`,
      [targetType, fileId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No se encontró el documento solicitado." });
    }

    res.json({
      message: `Documento movido exitosamente a '${targetType}'.`,
      file: result.rows[0]
    });
  } catch (err) {
    console.error("❌ Error al mover documento:", err);
    res.status(500).json({ message: "Error al cambiar la sección del documento: " + err.message });
  }
});

// GET /api/employees/:id/files -> Obtener lista de archivos/expediente digital del empleado
router.get("/:id/files", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM employee_files 
       WHERE employee_id::text = $1::text 
       ORDER BY created_at DESC`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener archivos del empleado:", err);
    res.status(500).json({ message: "No se pudieron obtener los archivos digitales: " + err.message });
  }
});

// Helper interno para eliminación limpia de archivos físicos y registros
const handleFileDelete = async (req, res) => {
  const { id, fileId } = req.params;
  const targetFileId = fileId || req.params.id;

  try {
    let queryStr = `SELECT * FROM employee_files WHERE id::text = $1::text`;
    let queryParams = [targetFileId];

    if (id && fileId) {
      queryStr = `SELECT * FROM employee_files WHERE id::text = $1::text AND employee_id::text = $2::text`;
      queryParams = [fileId, id];
    }

    const fileRes = await pool.query(queryStr, queryParams);

    if (fileRes.rows.length === 0) {
      return res.status(404).json({ message: "Archivo no encontrado." });
    }

    const file = fileRes.rows[0];
    const fileUrl = file.file_url || file.url || "";

    if (fileUrl) {
      const filename = path.basename(fileUrl);
      const filePath = path.join(uploadsDir, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn("No se pudo eliminar el archivo en disco:", e.message);
        }
      }
    }

    await pool.query(
      `DELETE FROM employee_files WHERE id::text = $1::text`,
      [file.id]
    );

    res.json({ message: "Archivo eliminado correctamente de la base de datos." });
  } catch (err) {
    console.error("❌ Error al eliminar archivo individual:", err);
    res.status(500).json({ message: "No se pudo eliminar el archivo: " + err.message });
  }
};

router.delete("/:id/files/:fileId", handleFileDelete);
router.delete("/files/:fileId", handleFileDelete);

// POST /api/employees/:id/upload-document -> Subir un único documento al expediente
router.post("/:id/upload-document", upload.single("file"), async (req, res) => {
  const { id } = req.params;
  const { fileType, file_type } = req.body;

  if (!req.file) {
    return res.status(400).json({ message: "No se seleccionó ningún archivo." });
  }

  try {
    const filePath = req.file.path;
    const relUrl = `/uploads/${path.basename(filePath)}`;
    const docType = fileType || file_type || "Formatos Varios";

    await pool.query(
      `DELETE FROM employee_files WHERE employee_id::text = $1::text AND file_type = $2`,
      [id, docType]
    );

    const insRes = await pool.query(
      `INSERT INTO employee_files (employee_id, file_name, file_url, file_type, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [id, req.file.originalname, relUrl, docType]
    );

    res.json(insRes.rows[0]);
  } catch (err) {
    console.error("❌ Error al subir documento individual:", err);
    res.status(500).json({ message: "Error al subir documento: " + err.message });
  }
});

router.post("/:id/files", upload.single("file"), async (req, res) => {
  const { id } = req.params;
  const { fileType, file_type } = req.body;

  if (!req.file) {
    return res.status(400).json({ message: "No se seleccionó ningún archivo." });
  }

  try {
    const filePath = req.file.path;
    const relUrl = `/uploads/${path.basename(filePath)}`;
    const docType = fileType || file_type || "Formatos Varios";

    await pool.query(
      `DELETE FROM employee_files WHERE employee_id::text = $1::text AND file_type = $2`,
      [id, docType]
    );

    const insRes = await pool.query(
      `INSERT INTO employee_files (employee_id, file_name, file_url, file_type, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [id, req.file.originalname, relUrl, docType]
    );

    res.json(insRes.rows[0]);
  } catch (err) {
    console.error("❌ Error al subir documento individual:", err);
    res.status(500).json({ message: "Error al subir documento: " + err.message });
  }
});

// 🟢 ROUTER ZIP DEL EXPEDIENTE
router.get("/:id/download-all", async (req, res) => {
  const { id } = req.params;

  try {
    const dbPool = typeof pool !== "undefined" ? pool : (req.db || req.pool);
    if (!dbPool) {
      return res.status(500).send("Error de conexión a la base de datos.");
    }

    const result = await dbPool.query(
      `SELECT * FROM employee_files WHERE employee_id::text = $1::text`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("El empleado no cuenta con archivos cargados en su expediente.");
    }

    const validFiles = result.rows.filter((file) => {
      const rawUrl = file.file_url || file.url || "";
      const filename = path.basename(rawUrl);
      const filePath = path.join(uploadsDir, filename);
      return fs.existsSync(filePath);
    });

    if (validFiles.length === 0) {
      return res.status(404).send("Los archivos del expediente no se encuentran almacenados en el disco del servidor.");
    }

    let archive;
    let useFallback = false;

    try {
      const archiverPkg = require("archiver");
      const archiverFn = typeof archiverPkg === "function" ? archiverPkg : archiverPkg.default || archiverPkg;
      if (typeof archiverFn === "function") {
        archive = archiverFn("zip", { zlib: { level: 9 } });
      } else {
        useFallback = true;
      }
    } catch (e) {
      useFallback = true;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="Expediente_${id}.zip"`);

    if (!useFallback && archive) {
      archive.on("error", (err) => {
        console.error("❌ Error Stream ZIP:", err);
        if (!res.headersSent) res.status(500).send("Error al generar el ZIP.");
      });

      archive.pipe(res);

      validFiles.forEach((file) => {
        const rawUrl = file.file_url || file.url || "";
        const filename = path.basename(rawUrl);
        const filePath = path.join(uploadsDir, filename);
        const categoryClean = (file.file_type || "Documento").replace(/[^a-zA-Z0-9_-]/g, "_");
        const zipEntryName = `${categoryClean}_${filename}`;

        archive.file(filePath, { name: zipEntryName });
      });

      await archive.finalize();
    } else {
      const zlib = require("zlib");

      const zipEntries = [];
      let offset = 0;

      for (const file of validFiles) {
        const rawUrl = file.file_url || file.url || "";
        const filename = path.basename(rawUrl);
        const filePath = path.join(uploadsDir, filename);

        const categoryClean = (file.file_type || "Documento").replace(/[^a-zA-Z0-9_-]/g, "_");
        const entryName = Buffer.from(`${categoryClean}_${filename}`);
        const fileContent = fs.readFileSync(filePath);

        let crc = 0xFFFFFFFF;
        for (let i = 0; i < fileContent.length; i++) {
          crc ^= fileContent[i];
          for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
          }
        }
        crc = (crc ^ 0xFFFFFFFF) >>> 0;

        const compressedContent = zlib.deflateRawSync(fileContent, { level: 9 });

        const localHeader = Buffer.alloc(30 + entryName.length);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 6);
        localHeader.writeUInt16LE(8, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressedContent.length, 18);
        localHeader.writeUInt32LE(fileContent.length, 22);
        localHeader.writeUInt16LE(entryName.length, 26);
        localHeader.writeUInt16LE(0, 28);
        entryName.copy(localHeader, 30);

        zipEntries.push({
          localHeader,
          compressedContent,
          entryName,
          crc,
          compSize: compressedContent.length,
          uncompSize: fileContent.length,
          offset
        });

        offset += localHeader.length + compressedContent.length;
      }

      const cdParts = [];
      let cdSize = 0;

      for (const entry of zipEntries) {
        const cdHeader = Buffer.alloc(46 + entry.entryName.length);
        cdHeader.writeUInt32LE(0x02014b50, 0);
        cdHeader.writeUInt16LE(20, 4);
        cdHeader.writeUInt16LE(20, 6);
        cdHeader.writeUInt16LE(0, 8);
        cdHeader.writeUInt16LE(8, 10);
        cdHeader.writeUInt16LE(0, 14);
        cdHeader.writeUInt16LE(0, 16);
        cdHeader.writeUInt32LE(entry.crc, 16);
        cdHeader.writeUInt32LE(entry.compSize, 20);
        cdHeader.writeUInt32LE(entry.uncompSize, 24);
        cdHeader.writeUInt16LE(entry.entryName.length, 28);
        cdHeader.writeUInt16LE(0, 30);
        cdHeader.writeUInt16LE(0, 32);
        cdHeader.writeUInt16LE(0, 34);
        cdHeader.writeUInt16LE(0, 36);
        cdHeader.writeUInt32LE(0, 38);
        cdHeader.writeUInt32LE(entry.offset, 42);
        entry.entryName.copy(cdHeader, 46);

        cdParts.push(cdHeader);
        cdSize += cdHeader.length;
      }

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(zipEntries.length, 8);
      eocd.writeUInt16LE(zipEntries.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(offset, 16);
      eocd.writeUInt16LE(0, 20);

      const finalBuffers = [];
      for (const entry of zipEntries) {
        finalBuffers.push(entry.localHeader);
        finalBuffers.push(entry.compressedContent);
      }
      cdParts.forEach(part => finalBuffers.push(part));
      finalBuffers.push(eocd);

      const zipBuffer = Buffer.concat(finalBuffers);
      res.end(zipBuffer);
    }
  } catch (err) {
    console.error("❌ Error al empaquetar expediente:", err);
    if (!res.headersSent) {
      res.status(500).send("Error al descargar expediente: " + err.message);
    }
  }
});

// 🟢 ENDPOINT PARA AUTORRELLENAR Y PROCESAR PLANTILLAS PERSONALIZADAS (.DOCX / .HTML)
router.post("/:id/fill-custom-template", upload.single("template"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    const empRes = await pool.query(
      `SELECT e.*, c.legal_name AS company_name, c.rfc AS company_rfc
       FROM employees e
       LEFT JOIN companies c ON c.id::text = e.company_id::text
       WHERE e.id::text = $1::text`,
      [id]
    );

    if (empRes.rows.length === 0) {
      return res.status(404).json({ message: "No se encontró el colaborador especificado." });
    }

    const e = empRes.rows[0];

    const filesRes = await pool.query(
      `SELECT file_name, file_type FROM employee_files WHERE employee_id::text = $1::text`,
      [id]
    );
    const expedienteArchivos = filesRes.rows.map(f => `${f.file_type}: ${f.file_name}`).join(", ");

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
      actividad: act,
      ACTIVIDAD: act
    }));

    const actividadesFormateadasTexto = lineasActividades.length > 0
      ? lineasActividades.map(item => `•  ${item}.`).join("\n")
      : rawActividades;

    const rawData = {
      nombre_completo: `${e.first_name || ""} ${e.last_name_paternal || e.last_name || ""} ${e.last_name_maternal || ""}`.trim(),
      nombre: e.first_name || "",
      first_name: e.first_name || "",
      apellido_paterno: e.last_name_paternal || e.last_name || "",
      last_name_paternal: e.last_name_paternal || e.last_name || "",
      apellido_materno: e.last_name_maternal || "",
      last_name_maternal: e.last_name_maternal || "",

      nss: e.nss || "SIN REGISTRAR",
      numero_seguro_social: e.nss || "SIN REGISTRAR",
      numero_imss: e.nss || "SIN REGISTRAR",
      social_security_number: e.nss || "SIN REGISTRAR",
      curp: e.curp || "SIN REGISTRAR",
      rfc: e.rfc || "SIN REGISTRAR",

      fecha_nacimiento: formatearFechaLarga(e.birth_date),
      birth_date: formatearFechaLarga(e.birth_date),
      edad: calcularEdad(e.birth_date),
      age: calcularEdad(e.birth_date),

      estado_civil: expandirEstadoCivil(e.marital_status),
      marital_status: expandirEstadoCivil(e.marital_status),

      genero: e.gender || "NO ESPECIFICADO",
      sexo: e.gender || "NO ESPECIFICADO",
      gender: e.gender || "NO ESPECIFICADO",

      nacionalidad: e.nationality || "MEXICANA",
      nationality: e.nationality || "MEXICANA",

      lugar_nacimiento: `${e.birth_place_municipality || ""}, ${e.birth_place_state || ""}`.trim() || "SIN REGISTRAR",
      escolaridad: e.education_level || "NO ESPECIFICADA",
      correo_personal: e.personal_email || "SIN CORREO",
      telefono: e.phone || e.mobile_phone || "SIN TELÉFONO",

      domicilio_personal: `${e.street || ""} #${e.exterior_number || ""} ${e.interior_number ? `INT. ${e.interior_number}` : ""}, COL. ${e.neighborhood || ""}, CP ${e.postal_code || ""}, ${e.municipality || ""}, ${e.state || ""}`.trim(),
      calle: e.street || "",
      num_exterior: e.exterior_number || "",
      num_interior: e.interior_number || "",
      colonia: e.neighborhood || "",
      cp: e.postal_code || "",
      municipio: e.municipality || "",
      estado: e.state || "",

      domicilio_fiscal: `${e.fiscal_street || e.street || ""} #${e.fiscal_exterior_number || e.exterior_number || ""} ${e.fiscal_interior_number ? `INT. ${e.fiscal_interior_number}` : ""}, COL. ${e.fiscal_neighborhood || e.neighborhood || ""}, CP ${e.fiscal_postal_code || e.postal_code || ""}, ${e.fiscal_municipality || e.municipality || ""}, ${e.fiscal_state || e.state || ""}`.trim(),

      salario_diario: `$${salarioDiarioNum.toFixed(2)} MXN`,
      salario_diario_num: salarioDiarioNum.toFixed(2),
      base_daily_salary: `$${salarioDiarioNum.toFixed(2)} MXN`,
      salario_diario_letra: salarioDiarioTexto,
      salario_diario_escrito: salarioDiarioTexto,
      base_daily_salary_letter: salarioDiarioTexto,

      salario_mensual: `$${salarioMensualNum.toFixed(2)} MXN`,
      salario_mensual_num: salarioMensualNum.toFixed(2),
      salario_mensual_letra: salarioMensualTexto,
      salario_mensual_escrito: salarioMensualTexto,
      salario_letra: salarioMensualTexto,
      salario_escrito: salarioMensualTexto,
      base_salary: `$${salarioMensualNum.toFixed(2)} MXN`,

      salario_diario_integrado: `$${salarioSdiNum.toFixed(2)} MXN`,
      sdi_salary: `$${salarioSdiNum.toFixed(2)} MXN`,

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
      company_name: e.company_name || "EMPRESA NO ASIGNADA",
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
      date_of_entry: fechaIngresoFormateada,

      fecha_inicio_contrato: formatearFechaLarga(e.contract_start_date || e.hire_date),
      fecha_termino_contrato: e.contract_end_date ? formatearFechaLarga(e.contract_end_date) : "INDEFINIDO",

      expediente_archivos: expedienteArchivos || "SIN DOCUMENTOS ADJUNTOS"
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

    if (!req.file) {
      return res.status(400).json({ message: "No se proporcionó ningún archivo de plantilla." });
    }

    const templatePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    
    let outputFilename = `${(name || "Documento").replace(/[^a-zA-Z0-9_-]/g, "_")}_${id.slice(0, 8)}_${Date.now()}`;
    let fileUrl = "";

    if (ext === ".docx" || ext === ".doc") {
      const content = fs.readFileSync(templatePath, "binary");
      const zip = new PizZip(content);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
      });

      doc.render(data);

      const buf = doc.getZip().generate({ type: "nodebuffer" });
      outputFilename += ".docx";
      const finalPath = path.join(uploadsDir, outputFilename);
      fs.writeFileSync(finalPath, buf);
      fileUrl = `/uploads/${outputFilename}`;

      if (fs.existsSync(templatePath)) fs.unlinkSync(templatePath);
    } else if (ext === ".html" || ext === ".txt") {
      let content = fs.readFileSync(templatePath, "utf8");

      Object.keys(data).forEach((key) => {
        const regex = new RegExp(`\\{${key}\\}`, "g");
        content = content.replace(regex, data[key] || "");
      });

      outputFilename += ".html";
      const finalPath = path.join(uploadsDir, outputFilename);
      fs.writeFileSync(finalPath, content, "utf8");
      fileUrl = `/uploads/${outputFilename}`;

      if (fs.existsSync(templatePath)) fs.unlinkSync(templatePath);
    } else {
      if (fs.existsSync(templatePath)) fs.unlinkSync(templatePath);
      return res.status(400).json({ message: "Formato no soportado. Usa una plantilla .docx o .html." });
    }

    await pool.query(
      `INSERT INTO employee_files (employee_id, file_name, file_url, file_type, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, `${name || "Documento_Personalizado"}${ext === ".docx" ? ".docx" : ".html"}`, fileUrl, "Formatos Varios"]
    ).catch(err => console.warn("Aviso al guardar en employee_files:", err.message));

    res.json({
      message: "Documento personalizado generado y rellenado exitosamente.",
      file_url: fileUrl,
      filename: outputFilename
    });

  } catch (error) {
    console.error("❌ Error al procesar plantilla personalizada:", error);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ message: "Error al autorrellenar la plantilla: " + error.message });
  }
});

// GET /api/employees/:id -> Obtener detalle de un empleado por ID (UUID)
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT e.*, c.legal_name AS company_name
       FROM employees e
       LEFT JOIN companies c ON c.id::text = e.company_id::text
       WHERE e.id::text = $1::text`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Empleado no encontrado." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error al obtener empleado por ID:", err);
    res.status(500).json({ message: "Error al obtener la información del empleado." });
  }
});

// POST /api/employees -> Crear empleado individual con Nombres Capitalizados
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const e = req.body;

    const firstNameCap = capitalize(e.first_name);
    const paternalCap = capitalize(e.last_name_paternal);
    const maternalCap = capitalize(e.last_name_maternal);
    const lastNameCap = [paternalCap, maternalCap].filter(Boolean).join(" ").trim() || capitalize(e.last_name);

    const actividadesInput = e.job_activities || e.jobActivities || e.actividades || e.actividades_puesto || null;

    const empResult = await client.query(
      `INSERT INTO employees (
        employee_number, first_name, last_name_paternal, last_name_maternal, last_name,
        curp, rfc, nss, birth_date, birth_place_municipality, birth_place_state,
        gender, marital_status, education_level, last_grade, personal_email, phone, mobile_phone,
        street, exterior_number, interior_number, neighborhood, postal_code, municipality, state, address,
        fiscal_street, fiscal_exterior_number, fiscal_interior_number, fiscal_neighborhood, fiscal_postal_code, fiscal_municipality, fiscal_state,
        department, position, job_activities, manager_id, company_id, hire_date, employment_status,
        contract_type, contract_start_date, contract_end_date,
        base_daily_salary, sdi_salary, base_salary, payroll_type,
        has_infonavit_credit, infonavit_credit_number, infonavit_discount_value,
        bank_name, bank_account, bank_clabe,
        emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
        beneficiary_name, beneficiary_relationship, beneficiary_phone
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34,
        $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50,
        $51, $52, $53, $54, $55, $56, $57, $58, $59
      ) RETURNING *`,
      [
        e.employee_number || null, firstNameCap, paternalCap || null, maternalCap || null, lastNameCap,
        e.curp ? e.curp.toUpperCase() : null, e.rfc ? e.rfc.toUpperCase() : null, e.nss || null, e.birth_date || null, capitalize(e.birth_place_municipality) || null, capitalize(e.birth_place_state) || null,
        e.gender || null, e.marital_status || null, e.education_level || null, e.last_grade || null, e.personal_email || null, e.phone || null, e.mobile_phone || null,
        e.street || null, e.exterior_number || null, e.interior_number || null, e.neighborhood || null, e.postal_code || null, e.municipality || null, e.state || null, e.address || null,
        e.fiscal_street || null, e.fiscal_exterior_number || null, e.fiscal_interior_number || null, e.fiscal_neighborhood || null, e.fiscal_postal_code || null, e.fiscal_municipality || null, e.fiscal_state || null,
        capitalize(e.department), capitalize(e.position) || null, actividadesInput, e.manager_id || null, e.company_id || null, e.hire_date, e.employment_status || 'activo',
        e.contract_type || null, e.contract_start_date || null, e.contract_end_date || null,
        e.base_daily_salary ? parseFloat(e.base_daily_salary) : null, e.sdi_salary ? parseFloat(e.sdi_salary) : null, e.base_salary ? parseFloat(e.base_salary) : null, e.payroll_type || 'QUI',
        e.has_infonavit_credit || 'NO', e.infonavit_credit_number || null, e.infonavit_discount_value ? parseFloat(e.infonavit_discount_value) : null,
        e.bank_name || null, e.bank_account || null, e.bank_clabe || null,
        capitalize(e.emergency_contact_name) || null, e.emergency_contact_relationship || null, e.emergency_contact_phone || null,
        capitalize(e.beneficiary_name) || null, e.beneficiary_relationship || null, e.beneficiary_phone || null
      ]
    );

    if (e.personal_email && e.personal_email.trim() !== "") {
      const emailClean = e.personal_email.trim().toLowerCase();
      const userCheck = await client.query("SELECT id FROM users WHERE LOWER(email) = $1", [emailClean]);

      if (userCheck.rows.length === 0) {
        const hashedPassword = await bcrypt.hash("NucleoRH2026!", 10);
        await client.query(
          `INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'empleado', true)`,
          [emailClean, hashedPassword]
        );
      }
    }

    await client.query("COMMIT");
    res.status(201).json(empResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error al crear empleado y usuario:", err);
    res.status(500).json({ message: "No se pudo registrar el expediente: " + err.message });
  } finally {
    client.release();
  }
});

// PUT /api/employees/:id -> Actualizar expediente de empleado
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const e = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const prevEmp = await client.query(
      "SELECT personal_email FROM employees WHERE id::text = $1::text",
      [id]
    );
    const oldEmail = prevEmp.rows[0]?.personal_email
      ? prevEmp.rows[0].personal_email.trim().toLowerCase()
      : null;

    const firstNameCap = capitalize(e.first_name);
    const paternalCap = capitalize(e.last_name_paternal);
    const maternalCap = capitalize(e.last_name_maternal);
    const lastNameCap =
      [paternalCap, maternalCap].filter(Boolean).join(" ").trim() ||
      capitalize(e.last_name);

    const actividadesInput = e.job_activities || e.jobActivities || e.actividades || e.actividades_puesto || null;

    const updateQuery = `
      UPDATE employees SET
        employee_number = $1,
        first_name = $2,
        last_name_paternal = $3,
        last_name_maternal = $4,
        last_name = $5,
        curp = $6,
        rfc = $7,
        nss = $8,
        birth_date = $9,
        birth_place_municipality = $10,
        birth_place_state = $11,
        gender = $12,
        marital_status = $13,
        education_level = $14,
        last_grade = $15,
        personal_email = $16,
        phone = $17,
        mobile_phone = $18,
        street = $19,
        exterior_number = $20,
        interior_number = $21,
        neighborhood = $22,
        postal_code = $23,
        municipality = $24,
        state = $25,
        address = $26,
        fiscal_street = $27,
        fiscal_exterior_number = $28,
        fiscal_interior_number = $29,
        fiscal_neighborhood = $30,
        fiscal_postal_code = $31,
        fiscal_municipality = $32,
        fiscal_state = $33,
        department = $34,
        position = $35,
        manager_id = $36,
        company_id = $37,
        hire_date = $38,
        employment_status = $39,
        contract_type = $40,
        contract_start_date = $41,
        contract_end_date = $42,
        base_daily_salary = $43,
        sdi_salary = $44,
        base_salary = $45,
        payroll_type = $46,
        has_infonavit_credit = $47,
        infonavit_credit_number = $48,
        infonavit_discount_value = $49,
        bank_name = $50,
        bank_account = $51,
        bank_clabe = $52,
        emergency_contact_name = $53,
        emergency_contact_relationship = $54,
        emergency_contact_phone = $55,
        beneficiary_name = $56,
        beneficiary_relationship = $57,
        beneficiary_phone = $58,
        job_activities = $59,
        work_schedule = $60,
        updated_at = CURRENT_TIMESTAMP
       WHERE id::text = $61::text
       RETURNING *`;

    const updateParams = [
      e.employee_number || null,                                                // $1
      firstNameCap,                                                             // $2
      paternalCap || null,                                                      // $3
      maternalCap || null,                                                      // $4
      lastNameCap,                                                              // $5
      e.curp ? e.curp.toUpperCase() : null,                                     // $6
      e.rfc ? e.rfc.toUpperCase() : null,                                       // $7
      e.nss || null,                                                            // $8
      e.birth_date || null,                                                     // $9
      capitalize(e.birth_place_municipality) || null,                          // $10
      capitalize(e.birth_place_state) || null,                                 // $11
      e.gender || null,                                                         // $12
      e.marital_status || null,                                                 // $13
      e.education_level || null,                                                // $14
      e.last_grade || null,                                                     // $15
      e.personal_email || null,                                                 // $16
      e.phone || null,                                                          // $17
      e.mobile_phone || null,                                                   // $18
      e.street || null,                                                         // $19
      e.exterior_number || null,                                                // $20
      e.interior_number || null,                                                // $21
      e.neighborhood || null,                                                   // $22
      e.postal_code || null,                                                    // $23
      e.municipality || null,                                                   // $24
      e.state || null,                                                          // $25
      e.address || null,                                                        // $26
      e.fiscal_street || null,                                                  // $27
      e.fiscal_exterior_number || null,                                         // $28
      e.fiscal_interior_number || null,                                         // $29
      e.fiscal_neighborhood || null,                                            // $30
      e.fiscal_postal_code || null,                                             // $31
      e.fiscal_municipality || null,                                            // $32
      e.fiscal_state || null,                                                   // $33
      capitalize(e.department),                                                 // $34
      capitalize(e.position) || null,                                           // $35
      e.manager_id || null,                                                     // $36
      e.company_id || null,                                                     // $37
      e.hire_date || null,                                                      // $38
      e.employment_status || "activo",                                          // $39
      e.contract_type || null,                                                  // $40
      e.contract_start_date || null,                                            // $41
      e.contract_end_date || null,                                              // $42
      e.base_daily_salary ? parseFloat(e.base_daily_salary) : null,            // $43
      e.sdi_salary ? parseFloat(e.sdi_salary) : null,                           // $44
      e.base_salary ? parseFloat(e.base_salary) : null,                         // $45
      e.payroll_type || "QUI",                                                  // $46
      e.has_infonavit_credit || "NO",                                           // $47
      e.infonavit_credit_number || null,                                        // $48
      e.infonavit_discount_value ? parseFloat(e.infonavit_discount_value) : null, // $49
      e.bank_name || null,                                                      // $50
      e.bank_account || null,                                                   // $51
      e.bank_clabe || null,                                                     // $52
      capitalize(e.emergency_contact_name) || null,                             // $53
      e.emergency_contact_relationship || null,                                 // $54
      e.emergency_contact_phone || null,                                        // $55
      capitalize(e.beneficiary_name) || null,                                   // $56
      e.beneficiary_relationship || null,                                       // $57
      e.beneficiary_phone || null,                                              // $58
      actividadesInput,                                                         // $59
      e.work_schedule || "Lunes a Viernes de 09:00 a 18:00 hrs",                // $60
      id                                                                        // $61
    ];

    const result = await client.query(updateQuery, updateParams);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Empleado no encontrado." });
    }

    if (e.personal_email && e.personal_email.trim() !== "") {
      const newEmailClean = e.personal_email.trim().toLowerCase();

      if (oldEmail && oldEmail !== newEmailClean) {
        await client.query(
          "UPDATE users SET email = $1 WHERE LOWER(email) = $2",
          [newEmailClean, oldEmail]
        );
      } else if (!oldEmail) {
        const userCheck = await client.query(
          "SELECT id FROM users WHERE LOWER(email) = $1",
          [newEmailClean]
        );
        if (userCheck.rows.length === 0) {
          const hashedPassword = await bcrypt.hash("NucleoRH2026!", 10);
          await client.query(
            `INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'empleado', true)`,
            [newEmailClean, hashedPassword]
          );
        }
      }
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error al actualizar expediente:", err.message);
    res.status(500).json({ message: "Error al actualizar el expediente: " + err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/employees/:id -> ELIMINAR CUALQUIER EMPLEADO REGISTRADO
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM employees WHERE id::text = $1::text RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Empleado no encontrado." });
    }

    if (result.rows[0].personal_email) {
      await pool.query("DELETE FROM users WHERE LOWER(email) = $1", [result.rows[0].personal_email.trim().toLowerCase()]).catch(() => {});
    }

    res.json({ message: "Empleado eliminado correctamente de la base de datos." });
  } catch (err) {
    console.error("Error al eliminar empleado:", err);
    res.status(500).json({ message: "Error al eliminar el empleado: " + err.message });
  }
});

module.exports = router;