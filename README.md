# SaMuSs Camelot Analyzer - GitHub Pages

Version estatica de SaMuSs Camelot Analyzer preparada para GitHub Pages.

## Como usar

1. Sube esta carpeta a un repositorio de GitHub.
2. En GitHub entra a Settings > Pages.
3. Selecciona Deploy from a branch.
4. Selecciona la rama main y la carpeta root.
5. Abre la URL generada por GitHub Pages.
6. En Firebase Authentication > Settings > Authorized domains agrega tu dominio de GitHub Pages:

```txt
tu_usuario.github.io
```

## Diferencia con la version Node.js

Esta version no usa servidor, Express, Multer ni npm. Todo ocurre en el navegador:

- Login con Firebase Authentication.
- Carga local de MP3/WAV.
- Analisis de los primeros 10 segundos.
- Estimacion de BPM.
- Deteccion aproximada de tonalidad.
- Conversion a Camelot.
- Ordenamiento armonico.
- Descarga de playlist CSV.
- Descarga de copias renombradas desde el navegador.

GitHub Pages no puede guardar archivos en carpetas como uploads/ o renamed/, por eso los archivos renombrados se generan como descargas locales.
