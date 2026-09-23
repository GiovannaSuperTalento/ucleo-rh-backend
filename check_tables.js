const pool = require("./db");

async function inspectDatabase() {
  try {
    console.log("🔍 INSPECCIONANDO TABLAS EN POSTGRESQL...\n");
    
    // 1. Obtener todas las tablas existentes en la base de datos
    const tablesRes = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    const tableNames = tablesRes.rows.map(r => r.table_name);
    console.log("📋 TABLAS ENCONTRADAS EN LA BASE DE DATOS:");
    console.log(tableNames);
    console.log("--------------------------------------------------\n");

    // 2. Inspeccionar estructura y contenido de cada tabla relevante
    for (const tableName of tableNames) {
      if (
        tableName.includes("note") || 
        tableName.includes("post") || 
        tableName.includes("cal") || 
        tableName.includes("event") || 
        tableName.includes("task") || 
        tableName.includes("pend") ||
        tableName.includes("remind")
      ) {
        console.log(`🔎 DETALLES DE LA TABLA: "${tableName}"`);
        
        // Obtener columnas
        const colsRes = await pool.query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = $1;
        `, [tableName]);
        
        console.log("   Columnas:", colsRes.rows.map(c => `${c.column_name} (${c.data_type})`));

        // Obtener primeros 3 registros de prueba
        const dataRes = await pool.query(`SELECT * FROM "${tableName}" LIMIT 3;`);
        console.log("   Registros (muestra):", dataRes.rows);
        console.log("--------------------------------------------------\n");
      }
    }
  } catch (err) {
    console.error("❌ Error inspeccionando DB:", err.message);
  } finally {
    await pool.end();
  }
}

inspectDatabase();