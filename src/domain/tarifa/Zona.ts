/** Zona de entrega: solo cambia el precio de los tipos con precio rural (hoy, la tela). */
export const ZONAS = ["URBANA", "RURAL"] as const;
export type Zona = (typeof ZONAS)[number];

export const ZONA_POR_DEFECTO: Zona = "URBANA";

export const esZona = (valor: unknown): valor is Zona => (ZONAS as readonly unknown[]).includes(valor);
