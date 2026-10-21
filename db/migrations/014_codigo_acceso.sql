-- PCargo — v17: código único de acceso opcional por usuario (entrar solo con el código).
-- Se guarda la huella HMAC-SHA256 en hex (nunca el código); única porque identifica al usuario en el login.
ALTER TABLE usuarios
  ADD COLUMN codigo_acceso_hash TEXT,
  ADD COLUMN codigo_acceso_en TIMESTAMPTZ,
  ADD CONSTRAINT usuarios_codigo_acceso_unico UNIQUE (codigo_acceso_hash),
  ADD CONSTRAINT usuarios_codigo_acceso_completo CHECK ((codigo_acceso_hash IS NULL) = (codigo_acceso_en IS NULL));
