CREATE UNIQUE INDEX IF NOT EXISTS inventory_serials_serial_no_upper_uidx ON public.inventory_serials (upper(btrim(serial_no)));
