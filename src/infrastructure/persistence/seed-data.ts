import type { TipoCarga, TipoCargaPublico } from "../../domain/carga/TipoCarga.js";
import type { ArticuloRestringido } from "../../domain/catalogo/ArticuloRestringido.js";
import type { Ciudad } from "../../domain/ruta/Ruta.js";
import type { Rol } from "../../domain/usuario/Usuario.js";

// Fuente única de datos semilla: la usan el seed de Postgres y el adaptador en memoria.

export const CIUDADES: Ciudad[] = [
  { id: 1, nombre: "Ibarra", activa: true },
  { id: 2, nombre: "Atuntaqui", activa: true },
  { id: 3, nombre: "Otavalo", activa: true },
  { id: 4, nombre: "Quito", activa: true },
];

/** Tipos de carga iniciales (contrato v8): precio por unidad; la ruta no influye. El orden es el del catálogo. */
const TIPOS_CARGA_INICIALES: TipoCargaPublico[] = [
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

/**
 * Catálogo inicial de tipos de carga (v11: configurable por el ADMIN). Solo se siembra si la tabla está vacía:
 * `db:seed` nunca reactiva, sobrescribe ni vuelve a crear tipos que el ADMIN cambió o eliminó.
 */
export const TIPOS_CARGA_SEED: readonly TipoCarga[] = TIPOS_CARGA_INICIALES.map((t, i) => ({
  ...t,
  activo: true,
  orden: i + 1,
  actualizadoEn: null,
  actualizadoPor: null,
}));

/** Fecha de la semilla de artículos restringidos (la migración 011 usa la hora en que se aplica). */
const FECHA_ARTICULOS_SEED = new Date("2026-10-12T00:00:00.000Z");

const articulo = (
  n: number,
  categoria: ArticuloRestringido["categoria"],
  orden: number,
  titulo: string,
  detalle: string,
  icono: ArticuloRestringido["icono"],
): ArticuloRestringido => ({
  id: `00000000-0000-4000-8011-${String(n).padStart(12, "0")}`,
  categoria,
  titulo,
  detalle,
  icono,
  activo: true,
  orden,
  actualizadoEn: FECHA_ARTICULOS_SEED,
  actualizadoPor: null,
});

/**
 * «Qué no transportamos» publicado en la landing en v9 (9 prohibidos, 3 condicionados, 2 notas). Es la semilla del
 * modo memoria; Postgres la siembra en `db/migrations/011_catalogo_configurable.sql` con los mismos ids y textos
 * (lo comprueba el contrato de repositorios). En las notas, el texto publicado es `titulo + " " + detalle`.
 */
export const ARTICULOS_SEED: readonly ArticuloRestringido[] = [
  articulo(1, "PROHIBIDO", 1, "Dinero en efectivo", "Billetes ni monedas, en ninguna cantidad.", "dinero"),
  articulo(2, "PROHIBIDO", 2, "Cheques y títulos valores", "Cheques, letras, pagarés y otros documentos de valor negociable.", "documento"),
  articulo(3, "PROHIBIDO", 3, "Joyas y metales preciosos", "Oro, plata, piedras preciosas y alhajas.", "joya"),
  articulo(4, "PROHIBIDO", 4, "Armas y municiones", "Armas de cualquier tipo, municiones y sus partes.", "arma"),
  articulo(5, "PROHIBIDO", 5, "Explosivos y pirotecnia", "Pólvora, fuegos artificiales y material explosivo.", "explosivo"),
  articulo(6, "PROHIBIDO", 6, "Sustancias peligrosas", "Líquidos inflamables, gases, corrosivos y tóxicos.", "fuego"),
  articulo(7, "PROHIBIDO", 7, "Drogas y sustancias fiscalizadas", "Estupefacientes, psicotrópicos y sustancias sujetas a fiscalización.", "droga"),
  articulo(8, "PROHIBIDO", 8, "Animales vivos", "Mascotas, aves ni ningún otro animal.", "animal"),
  articulo(9, "PROHIBIDO", 9, "Mercadería ilícita", "Productos falsificados, de contrabando o de comercio prohibido.", "prohibido"),
  articulo(10, "CONDICIONADO", 1, "Perecibles", "Solo bien embalados y para entrega en el mismo día.", "perecible"),
  articulo(11, "CONDICIONADO", 2, "Líquidos no peligrosos", "Solo en envase sellado.", "liquido"),
  articulo(12, "CONDICIONADO", 3, "Objetos frágiles", "Con embalaje adecuado y declarando el contenido.", "fragil"),
  // El título admite 80 caracteres: la primera nota (99) se reparte en título + detalle.
  articulo(13, "NOTA", 1, "Declara siempre el contenido real de tu envío.", "Podemos pedir revisar un paquete antes de recibirlo.", null),
  articulo(14, "NOTA", 2, "No entregamos en apartados postales.", "", null),
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
