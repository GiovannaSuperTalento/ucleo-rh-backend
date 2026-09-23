// db.js — Conexión a PostgreSQL
// Este archivo crea un "pool" de conexiones reutilizables hacia la base de datos.
// Cualquier otro archivo del backend que necesite hablar con la base de datos
// va a importar este archivo en vez de conectarse por su cuenta.

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

module.exports = pool;
