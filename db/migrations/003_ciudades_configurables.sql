-- PCargo — v3: ciudades de cobertura configurables (activar/desactivar, nombres únicos sin distinguir mayúsculas).

ALTER TABLE ciudades ADD COLUMN activa BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE ciudades ADD CONSTRAINT ciudades_nombre_longitud CHECK (char_length(nombre) BETWEEN 2 AND 60);
CREATE UNIQUE INDEX ux_ciudades_nombre_ci ON ciudades (lower(nombre));
