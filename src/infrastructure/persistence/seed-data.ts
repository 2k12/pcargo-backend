import type { TipoCarga } from "../../domain/carga/TipoCarga.js";
import type { Ciudad } from "../../domain/ruta/Ruta.js";
import type { Rol } from "../../domain/usuario/Usuario.js";

// Fuente única de datos semilla: la usan el seed de Postgres y el adaptador en memoria.

export const CIUDADES: Ciudad[] = [
  { id: 1, nombre: "Ibarra", activa: true },
  { id: 2, nombre: "Atuntaqui", activa: true },
  { id: 3, nombre: "Otavalo", activa: true },
  { id: 4, nombre: "Quito", activa: true },
];

export const TIPOS_CARGA_SEED: TipoCarga[] = [
  { codigo: "SOBRE", nombre: "Sobre", factor: 1.0, pesoIncluidoKg: 0.5, pesoMaxKg: 0.5 },
  { codigo: "PAQUETE", nombre: "Paquete", factor: 1.4, pesoIncluidoKg: 2, pesoMaxKg: 30 },
  { codigo: "CARTON", nombre: "Cartón", factor: 1.6, pesoIncluidoKg: 2, pesoMaxKg: 40 },
  { codigo: "VALIJA", nombre: "Valija", factor: 1.8, pesoIncluidoKg: 2, pesoMaxKg: 25 },
];

/** [origenId, destinoId, tarifaBase USD, minutos]. Las interurbanas se siembran en ambos sentidos. */
const URBANAS: [number, number, number, number][] = [
  [1, 1, 2.0, 60],
  [2, 2, 1.75, 45],
  [3, 3, 1.75, 45],
  [4, 4, 3.0, 120],
];
const INTERURBANAS: [number, number, number, number][] = [
  [1, 2, 2.5, 30],
  [1, 3, 3.0, 45],
  [2, 3, 2.5, 30],
  [1, 4, 6.0, 180],
  [2, 4, 5.5, 165],
  [3, 4, 5.0, 150],
];

export const RUTAS_SEED = [
  ...URBANAS,
  ...INTERURBANAS.flatMap(([o, d, t, m]) => [
    [o, d, t, m],
    [d, o, t, m],
  ]),
].map(([origenId, destinoId, tarifaBase, tiempoEstimadoMin], i) => ({
  id: i + 1,
  origenId: origenId!,
  destinoId: destinoId!,
  tarifaBase: tarifaBase!,
  tiempoEstimadoMin: tiempoEstimadoMin!,
}));

export const USUARIOS_SEED: { id: string; nombre: string; email: string; password: string; rol: Rol }[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    nombre: "Administrador PCargo",
    email: "admin@pcargo.ec",
    password: "Admin123!",
    rol: "ADMIN",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    nombre: "Operador Ibarra",
    email: "operador@pcargo.ec",
    password: "Operador123!",
    rol: "OPERADOR",
  },
];
