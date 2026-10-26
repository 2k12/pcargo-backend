/**
 * Consecutivo de números de guía en memoria (v21), equivalente a la tabla `secuencia_guias` de Postgres: el siguiente
 * número es el menor n > `ultimo` que no está ocupado por ningún envío ni talonario; un talonario de k números toma el
 * primer bloque contiguo libre después de `ultimo`. Los repositorios de envíos y talonarios registran de dónde salen
 * los números ocupados y avanzan el contador al guardar (sin `await` de por medio: atómico en el bucle de eventos).
 */
export class SecuenciaGuiasMemoria {
  private ultimo = 0;
  private readonly fuentes: (() => Iterable<number>)[] = [];

  /** Origen de números ocupados (p. ej. los `numeroGuia` de los envíos guardados). */
  agregarFuente(fuente: () => Iterable<number>): void {
    this.fuentes.push(fuente);
  }

  get valor(): number {
    return this.ultimo;
  }

  /** Primer número de un bloque contiguo libre de `cantidad` números después del contador (no lo avanza). */
  primerBloqueLibre(cantidad = 1): number {
    const ocupados = new Set<number>();
    for (const fuente of this.fuentes) for (const n of fuente()) if (n > this.ultimo) ocupados.add(n);
    let desde = this.ultimo + 1;
    for (;;) {
      let libres = 0;
      while (libres < cantidad && !ocupados.has(desde + libres)) libres++;
      if (libres === cantidad) return desde;
      desde += libres + 1;
    }
  }

  /** El contador pasa a `n` si es mayor (nunca retrocede). */
  avanzar(n: number): void {
    if (n > this.ultimo) this.ultimo = n;
  }
}
