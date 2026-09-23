const pool = require("./db");

async function testInsert() {
  try {
    const res = await pool.query(`
      INSERT INTO tasks (title, description, column_id, created_at) 
      VALUES (
        'Prueba urgente', 
        'Guardado directamente desde la base de datos', 
        '11111111-1111-1111-1111-111111111111'::uuid, 
        NOW()
      ) 
      RETURNING *;
    `);
    
    console.log("✅ Inserción manual exitosa en PostgreSQL:");
    console.log(res.rows[0]);
  } catch (err) {
    console.error("❌ Error en la inserción:", err.message);
  } finally {
    await pool.end();
  }
}

testInsert();