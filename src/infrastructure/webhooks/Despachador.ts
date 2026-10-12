// Despachador en proceso: cada `intervaloSeg` envía los webhooks pendientes (outbox) y, cada hora, purga la
// auditoría vencida y las claves de idempotencia. Solo lo arranca main.ts (nunca los tests).

export interface TareasDespachador {
  despachar: { ejecutar(): Promise<number> };
  purgar: { ejecutar(): Promise<unknown> };
}

const HORA_MS = 60 * 60 * 1000;

export class Despachador {
  private temporizador: NodeJS.Timeout | null = null;
  private enCurso: Promise<void> | null = null;
  private ultimaPurga = 0;

  constructor(
    private readonly tareas: TareasDespachador,
    private readonly intervaloSeg: number,
    private readonly log: (m: string, e?: unknown) => void = (m, e) => console.error(m, e ?? ""),
  ) {}

  iniciar(): void {
    if (this.temporizador) return;
    this.temporizador = setInterval(() => void this.ciclo(), this.intervaloSeg * 1000);
    this.temporizador.unref();
    void this.ciclo();
  }

  /** Un ciclo; si el anterior sigue en curso no se solapa. */
  ciclo(): Promise<void> {
    this.enCurso ??= this.ejecutar().finally(() => {
      this.enCurso = null;
    });
    return this.enCurso;
  }

  private async ejecutar(): Promise<void> {
    try {
      // Vacía la cola por lotes, sin quedarse en un bucle infinito si algo falla repetidamente.
      for (let i = 0; i < 10 && (await this.tareas.despachar.ejecutar()) > 0; i++);
    } catch (e) {
      this.log("Despachador de webhooks: error al despachar", e);
    }
    if (Date.now() - this.ultimaPurga >= HORA_MS) {
      this.ultimaPurga = Date.now();
      try {
        await this.tareas.purgar.ejecutar();
      } catch (e) {
        this.log("Despachador de webhooks: error al purgar registros", e);
      }
    }
  }

  async detener(): Promise<void> {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
    await this.enCurso;
  }
}
