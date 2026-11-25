# Simuladores ejecutables de referencia
Python 3.10+ estándar, sin credenciales ni dependencias. Desde raíz:
```
python 23_SIMULATORS/simulator.py
python -m unittest discover -s 23_SIMULATORS -p "test_*.py" -v
```
El simulador usa SQLite in-memory para reservas y dedup, Decimal para precio, hash de revisiones, pagos sintéticos, operaciones de sync y gates de fabricación. Modelos/proveedores reales NO se invocan. Estado no persiste entre ejecuciones; no es backend de producción. Casos extras definidos para futuras implementaciones: FX/metal feed, logística, IA error y timeout, disponibilidad de proveedor, escalamiento. Adaptar interfaz a NestJS/Python sin cambiar invariantes.
