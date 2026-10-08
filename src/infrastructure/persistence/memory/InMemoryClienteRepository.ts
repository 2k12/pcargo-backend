import type { ClienteRepository } from "../../../application/ports/repositories.js";
import { digitosTelefono, type Cliente, type DatosCliente } from "../../../domain/cliente/Cliente.js";

export class InMemoryClienteRepository implements ClienteRepository {
  private readonly datos = new Map<string, Cliente>();

  async listar(filtro: { q?: string } = {}): Promise<Cliente[]> {
    const q = filtro.q?.trim().toLowerCase();
    const digitos = q ? digitosTelefono(q) : "";
    return [...this.datos.values()]
      .filter(
        (c) =>
          !q || c.nombre.toLowerCase().includes(q) || (digitos !== "" && digitosTelefono(c.telefono).includes(digitos)),
      )
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }))
      .map((c) => ({ ...c }));
  }

  async buscarPorId(id: string): Promise<Cliente | null> {
    const c = this.datos.get(id);
    return c ? { ...c } : null;
  }

  async buscarPorTelefono(telefono: string, excluirId?: string): Promise<Cliente | null> {
    const d = digitosTelefono(telefono);
    const c = [...this.datos.values()].find((x) => x.id !== excluirId && digitosTelefono(x.telefono) === d);
    return c ? { ...c } : null;
  }

  async crear(cliente: Cliente): Promise<void> {
    this.datos.set(cliente.id, { ...cliente, consentimientoEn: cliente.consentimientoEn ?? null });
  }

  async actualizar(id: string, d: Required<DatosCliente>): Promise<Cliente> {
    const c = { ...this.datos.get(id)!, ...d };
    this.datos.set(id, c);
    return { ...c };
  }

  async registrarConsentimiento(id: string, fecha: Date): Promise<Cliente> {
    const actual = this.datos.get(id)!;
    const c = { ...actual, consentimientoEn: actual.consentimientoEn ?? new Date(fecha) };
    this.datos.set(id, c);
    return { ...c };
  }

  async eliminar(id: string): Promise<void> {
    this.datos.delete(id);
  }
}
