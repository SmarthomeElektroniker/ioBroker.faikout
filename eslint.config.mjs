import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-console': 'off',
        },
    },
    {
        // Die VIS-Widgets laufen im Browser, nicht in Node: dort stellt VIS `vis`, `jQuery`
        // und `systemDictionary` bereit. Ohne diese Angabe meldet der Linter sie als unbekannt.
        files: ['widgets/**/*.js'],
        languageOptions: {
            ecmaVersion: 2019,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...globals.jquery,
                vis: 'readonly',
                systemDictionary: 'writable',
            },
        },
    },
    {
        ignores: ['node_modules/**', 'admin/**', 'test/**', 'coverage/**', '*.config.mjs'],
    },
];
