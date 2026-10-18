import type { Cliente } from "../../../domain/cliente/Cliente.js";
import {
  digitosTitular,
  fechaCorte,
  normalizarSolicitud,
  validarMesesRetencion,
  type DatosSolicitud,
  type SolicitudDatos,
} from "../../../domain/datos/DatosPersonales.js";
import type { Envio } from "../../../domain/envio/Envio.js";
import { ESTADOS, ESTADOS_FINALES, esFinal } from "../../../domain/envio/EstadoEnvio.js";
import { exigirRol, type Actor } from "../../../domain/usuario/Usuario.js";
import type { IntegracionRepository } from "../../ports/integraciones.js";
import type {
  ClienteRepository,
  DatosPersonalesRepository,
  EnvioRepository,
  Paginacion,
  UsuarioRepository,
} from "../../ports/repositories.js";
import type { AlmacenArchivos, Clock, IdGenerator } from "../../ports/services.js";
import { POR_PAGINA_DEFECTO, POR_PAGINA_MAX, type PaginaDTO } from "../envios/ConsultasEnvio.js";
import { eliminarSinFallar } from "../envios/EvidenciaEntrega.js";

// Retención y eliminación de datos personales (LOPDP, contrato v12). Solo ADMIN (y la depuración diaria del servidor).

export interface DepsDatos {
  envios: EnvioRepository;
  clientes: ClienteRepository;
  usuarios: UsuarioRepository;
  integraciones: IntegracionRepository;
  datos: DatosPersonalesRepository;
  almacen: AlmacenArchivos;
  ids: IdGenerator;
  clock: Clock;
}

export interface PoliticaDatosDTO {
  mesesRetencion: number;
  ultimaDepuracion: { fecha: string; envios: number; clientes: number; evidencias: number } | null;
  pendientes: { envios: number; clientes: number };
}

export interface ResultadoDepuracionDTO {
  simulado: boolean;
  envios: number;
  clientes: number;
  evidencias: number;
  fechaCorte: string;
}

export interface DatosTitularDTO {
  telefono: string;
  cliente: { id: string; nombre: string; accesosPortal: number } | null;
  envios: { total: number; terminados: number; enCurso: number; anonimizados: number };
}

export interface SolicitudDatosDTO extends Omit<SolicitudDatos, "fecha"> {
  fecha: string;
}

const SOLO_ADMIN = ["ADMIN"] as const;
const NO_FINALES = ESTADOS.filter((e) => !esFinal(e));

const toSolicitudDTO = (s: SolicitudDatos): SolicitudDatosDTO => ({
  ...s,
  resultado: { ...s.resultado },
  fecha: s.fecha.toISOString(),
});

/** Anonimiza los envíos y borra sus fotos de evidencia del almacén. */
async function anonimizarEnvios(d: DepsDatos, envios: Envio[], ahora: Date): Promise<{ envios: number; evidencias: number }> {
  let evidencias = 0;
  for (const envio of envios) {
    const evidencia = envio.anonimizar(ahora);
    await d.envios.guardar(envio);
    if (evidencia) {
      evidencias++;
      await eliminarSinFallar(d.almacen, evidencia.clave);
    }
  }
  return { envios: envios.length, evidencias };
}

interface PlanDepuracion {
  corte: Date;
  envios: Envio[];
  clientes: Cliente[];
}

/**
 * Qué tocaría la depuración: envíos terminados (por `actualizadoEn`) antes del corte y aún con datos, y clientes
 * inactivos (creados antes del corte, sin envíos en curso ni actualizados dentro del plazo, sin usuarios del portal
 * activos ni integraciones).
 */
async function planificar(d: DepsDatos, ahora: Date, meses: number): Promise<PlanDepuracion> {
  const corte = fechaCorte(ahora, meses);
  const [envios, recientes, enCurso, clientes, accesos, integraciones] = await Promise.all([
    d.envios.listar({ estados: [...ESTADOS_FINALES], actualizadoAntes: corte, anonimizado: false }),
    d.envios.listar({ actualizadoDesde: corte }),
    d.envios.listar({ estados: NO_FINALES }),
    d.clientes.listar(),
    d.usuarios.accesosPortalPorCliente(),
    d.integraciones.listar(),
  ]);
  const activos = new Set<string>();
  for (const e of [...recientes, ...enCurso]) if (e.clienteId) activos.add(e.clienteId);
  for (const i of integraciones) if (i.clienteId) activos.add(i.clienteId);
  const inactivos = clientes.filter(
    (c) => c.creadoEn < corte && !activos.has(c.id) && (accesos.get(c.id) ?? 0) === 0,
  );
  return { corte, envios, clientes: inactivos };
}

async function politica(d: DepsDatos): Promise<PoliticaDatosDTO> {
  const config = await d.datos.obtenerConfiguracion();
  const plan = await planificar(d, d.clock.ahora(), config.mesesRetencion);
  const u = config.ultimaDepuracion;
  return {
    mesesRetencion: config.mesesRetencion,
    ultimaDepuracion: u && { fecha: u.fecha.toISOString(), envios: u.envios, clientes: u.clientes, evidencias: u.evidencias },
    pendientes: { envios: plan.envios.length, clientes: plan.clientes.length },
  };
}

export class ObtenerPoliticaDatos {
  constructor(private readonly d: DepsDatos) {}

  async ejecutar(actor: Actor): Promise<PoliticaDatosDTO> {
    exigirRol(actor, SOLO_ADMIN);
    return politica(this.d);
  }
}

export class ActualizarPoliticaDatos {
  constructor(private readonly d: DepsDatos) {}

  async ejecutar(actor: Actor, mesesRetencion: number): Promise<PoliticaDatosDTO> {
    exigirRol(actor, SOLO_ADMIN);
    await this.d.datos.guardarMesesRetencion(validarMesesRetencion(mesesRetencion));
    return politica(this.d);
  }
}

/** Depuración por plazo de conservación. `actor` null = la ejecución diaria del servidor. */
export class DepurarDatos {
  constructor(private readonly d: DepsDatos) {}

  async ejecutar(actor: Actor | null, opciones: { simular?: boolean } = {}): Promise<ResultadoDepuracionDTO> {
    if (actor) exigirRol(actor, SOLO_ADMIN);
    const ahora = this.d.clock.ahora();
    const { mesesRetencion } = await this.d.datos.obtenerConfiguracion();
    const plan = await planificar(this.d, ahora, mesesRetencion);
    const simulado = opciones.simular === true;
    if (simulado) {
      return {
        simulado,
        envios: plan.envios.length,
        clientes: plan.clientes.length,
        evidencias: plan.envios.filter((e) => e.evidencia).length,
        fechaCorte: plan.corte.toISOString(),
      };
    }
    const { envios, evidencias } = await anonimizarEnvios(this.d, plan.envios, ahora);
    for (const c of plan.clientes) await this.d.clientes.eliminar(c.id);
    const clientes = plan.clientes.length;
    await this.d.datos.registrarDepuracion({ fecha: ahora, envios, clientes, evidencias });
    return { simulado, envios, clientes, evidencias, fechaCorte: plan.corte.toISOString() };
  }
}

/** Envíos asociados a un teléfono (remitente o destinatario, por dígitos) o al cliente con ese teléfono. */
async function enviosDelTitular(d: DepsDatos, digitos: string, cliente: Cliente | null): Promise<Envio[]> {
  const [porTelefono, delCliente] = await Promise.all([
    d.envios.listar({ telefono: digitos }),
    cliente ? d.envios.listar({ clienteId: cliente.id }) : Promise.resolve([]),
  ]);
  const unicos = new Map<string, Envio>();
  for (const e of [...porTelefono, ...delCliente]) unicos.set(e.id, e);
  return [...unicos.values()];
}

export class ConsultarTitular {
  constructor(private readonly d: DepsDatos) {}

  async ejecutar(actor: Actor, telefono: string): Promise<DatosTitularDTO> {
    exigirRol(actor, SOLO_ADMIN);
    const digitos = digitosTitular(telefono);
    const cliente = await this.d.clientes.buscarPorTelefono(digitos);
    const [envios, accesos] = await Promise.all([
      enviosDelTitular(this.d, digitos, cliente),
      cliente ? this.d.usuarios.accesosPortalPorCliente() : Promise.resolve(new Map<string, number>()),
    ]);
    const anonimizados = envios.filter((e) => e.anonimizadoEn).length;
    const enCurso = envios.filter((e) => !esFinal(e.estado)).length;
    return {
      telefono,
      cliente: cliente && { id: cliente.id, nombre: cliente.nombre, accesosPortal: accesos.get(cliente.id) ?? 0 },
      envios: { total: envios.length, terminados: envios.length - enCurso - anonimizados, enCurso, anonimizados },
    };
  }
}

/**
 * Solicitud de eliminación del titular: anonimiza sus envíos terminados y elimina el cliente con ese teléfono
 * (desactivando sus usuarios del portal). Los envíos en curso no se tocan. Queda registro (solo 4 dígitos).
 */
export class AtenderSolicitudDatos {
  constructor(private readonly d: DepsDatos) {}

  async ejecutar(actor: Actor, datos: DatosSolicitud): Promise<SolicitudDatosDTO> {
    exigirRol(actor, SOLO_ADMIN);
    const s = normalizarSolicitud(datos);
    const ahora = this.d.clock.ahora();
    const cliente = await this.d.clientes.buscarPorTelefono(s.digitos);
    const envios = await enviosDelTitular(this.d, s.digitos, cliente);
    const terminados = envios.filter((e) => esFinal(e.estado) && !e.anonimizadoEn);
    const enCurso = envios.filter((e) => !esFinal(e.estado)).length;
    const anonimizados = await anonimizarEnvios(this.d, terminados, ahora);
    const usuariosDesactivados = cliente ? await this.d.clientes.eliminar(cliente.id) : 0;
    const solicitud: SolicitudDatos = {
      id: this.d.ids.uuid(),
      tipo: "ELIMINACION",
      nombreTitular: s.nombreTitular,
      telefonoFinal: `…${s.digitos.slice(-4)}`,
      canal: s.canal,
      nota: s.nota,
      fecha: ahora,
      atendidaPor: actor.nombre,
      resultado: {
        envios: anonimizados.envios,
        clientes: cliente ? 1 : 0,
        evidencias: anonimizados.evidencias,
        usuariosDesactivados,
        enCurso,
      },
    };
    await this.d.datos.crearSolicitud(solicitud);
    return toSolicitudDTO(solicitud);
  }
}

export class ListarSolicitudesDatos {
  constructor(private readonly d: DepsDatos) {}

  async ejecutar(actor: Actor, paginacion: Partial<Paginacion> = {}): Promise<PaginaDTO<SolicitudDatosDTO>> {
    exigirRol(actor, SOLO_ADMIN);
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    const { solicitudes, total } = await this.d.datos.listarSolicitudes({ pagina, porPagina });
    return {
      datos: solicitudes.map(toSolicitudDTO),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.ceil(total / porPagina),
    };
  }
}
