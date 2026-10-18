// Tarea en proceso que se repite cada `intervaloSeg` (p. ej. la depuración diaria de datos personales, v12).
// Como el Despachador de webhooks: solo la arranca main.ts (nunca los tests), no se solapa y no impide cerrar el proceso.

export class TareaPeriodica {
  private temporizador: NodeJS.Timeout | null = null;
  private enCurso: Promise<void> | null = null;

  constructor(
    private readonly nombre: string,
    private readonly tarea: () => Promise<unknown>,
    private readonly intervaloSeg: number,
    private readonly log: (m: string, e?: unknown) => void = (m, e) => console.error(m, e ?? ""),
  ) {}

  /** Ejecuta un ciclo al iniciar y luego uno por intervalo. */
  iniciar(): void {
    if (this.temporizador) return;
    this.temporizador = setInterval(() => void this.ciclo(), this.intervaloSeg * 1000);
    this.temporizador.unref();
    void this.ciclo();
  }

  /** Un ciclo; si el anterior sigue en curso no se solapa. Los errores se registran y no detienen la tarea. */
  ciclo(): Promise<void> {
    this.enCurso ??= this.tarea()
      .then(() => undefined)
      .catch((e) => this.log(`${this.nombre}: error`, e))
      .finally(() => {
        this.enCurso = null;
      });
    return this.enCurso;
  }

  async detener(): Promise<void> {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
    await this.enCurso;
  }
}
