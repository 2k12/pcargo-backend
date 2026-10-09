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

/** Catálogo de tipos de carga (contrato v8): precio por unidad; la ruta no influye. El orden es el del catálogo. */
export const TIPOS_CARGA_SEED: TipoCarga[] = [
  { codigo: "SOBRE", nombre: "Sobre", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 0.5 },
  { codigo: "PAQUETE", nombre: "Paquete", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 50 },
  { codigo: "CARTON", nombre: "Cartón", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 35 },
  { codigo: "VALIJA", nombre: "Valija", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 25 },
  {
    codigo: "TELA",
    nombre: "Rollo de tela",
    precio: 1.25,
    precioRural: 1.5,
    mayoreo: { minimoExclusivo: 50, precio: 1 },
    pesoMaxKg: 50,
  },
  // Tela y plumón son variantes de paquete: heredan su peso máximo.
  { codigo: "PLUMON_PEQUENO", nombre: "Plumón pequeño", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 50 },
  { codigo: "PLUMON_GRANDE", nombre: "Plumón grande", precio: 4, precioRural: null, mayoreo: null, pesoMaxKg: 50 },
];

/** [origenId, destinoId, minutos]. Las interurbanas se siembran en ambos sentidos. Las rutas no tienen tarifa (v8). */
const URBANAS: [number, number, number][] = [
  [1, 1, 60],
  [2, 2, 45],
  [3, 3, 45],
  [4, 4, 120],
];
const INTERURBANAS: [number, number, number][] = [
  [1, 2, 30],
  [1, 3, 45],
  [2, 3, 30],
  [1, 4, 180],
  [2, 4, 165],
  [3, 4, 150],
];

export const RUTAS_SEED = [
  ...URBANAS,
  ...INTERURBANAS.flatMap(([o, d, m]) => [
    [o, d, m],
    [d, o, m],
  ]),
].map(([origenId, destinoId, tiempoEstimadoMin], i) => ({
  id: i + 1,
  origenId: origenId!,
  destinoId: destinoId!,
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
