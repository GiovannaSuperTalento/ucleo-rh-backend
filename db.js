// db.js — Conexión a PostgreSQL
require("dotenv").config();
const { Pool } = require("pg");

// 🟢 Si existe DATABASE_URL (Railway / Producción), la usamos directamente.
// De lo contrario, construimos con variables individuales o valores por defecto locales.
const connectionString = process.env.DATABASE_URL || 
  `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'railway'}`;

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' || connectionString.includes('railway') 
    ? { rejectUnauthorized: false } 
    : false
});

module.exports = pool;