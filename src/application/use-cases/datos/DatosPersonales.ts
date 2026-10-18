import type { Cliente } from "../../../domain/cliente/Cliente.js";
import {
  digitosTitular,
  normalizarSolicitud,
  type DatosSolicitud,
  type SolicitudDatos,
} from "../../../domain/datos/DatosPersonales.js";
import type { Envio } from "../../../domain/envio/Envio.js";
import { esFinal } from "../../../domain/envio/EstadoEnvio.js";
import { exigirRol, type Actor } from "../../../domain/usuario/Usuario.js";
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

// Datos personales (LOPDP, contrato v13). Solo ADMIN. El plazo de conservación es declarado (informativo): el sistema
// nunca elimina ni anonimiza por su cuenta; solo lo hace al atender una solicitud del titular.

export interface DepsDatos {
  envios: EnvioRepository;
  clientes: ClienteRepository;
  usuarios: UsuarioRepository;
  datos: DatosPersonalesRepository;
  almacen: AlmacenArchivos;
  ids: IdGenerator;
  clock: Clock;
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
