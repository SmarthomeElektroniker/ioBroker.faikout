// Nur fuer den Rauchtest (smoke.mjs): die Komponenten ohne Module Federation laden und auf dem
// Server rendern. Gehoert nicht zum Adapterpaket.
import react from '@vitejs/plugin-react';
import commonjs from 'vite-plugin-commonjs';

export default {
    plugins: [react(), commonjs()],
    base: './',
    build: { commonjsOptions: { include: [/lib\//, /widgets\//, /node_modules/] } },
};
