import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        rules: {
            // Der Adapter loggt ueber this.log; console bleibt den Werkzeugen vorbehalten.
            'no-console': 'off',
        },
    },
    {
        ignores: [
            'node_modules/**',
            'admin/**',
            'widgets/**',
            'test/**',
            'coverage/**',
            '*.config.mjs',
        ],
    },
];
