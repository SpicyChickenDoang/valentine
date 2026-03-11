// .eslintrc.js
module.exports = {
    env: {
        node: true,
        es2021: true,
        jest: true
    },
    extends: ['eslint:recommended'],
    parserOptions: {
        ecmaVersion: 2021
    },
    rules: {
        // ERRORS — release blocked
        'no-undef': 'error',              // Catch ReferenceError before runtime
        'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'no-dupe-keys': 'error',           // Duplicate object keys
        'no-duplicate-case': 'error',      // Duplicate switch cases
        'no-unreachable': 'error',         // Dead code after return
        'no-const-assign': 'error',        // Reassigning const
        'use-isnan': 'error',              // Use isNaN() not === NaN
        'valid-typeof': 'error',           // typeof === 'strng' typos

        // WARNINGS — tech debt
        'no-console': ['warn', { allow: ['warn', 'error'] }],
        'prefer-const': 'warn',
        'no-var': 'warn',
        'eqeqeq': ['warn', 'always'],       // === instead of ==

        // OFF — handled elsewhere or too noisy
        'no-empty': 'off'                  // Empty catch blocks OK for fail-silent
    },
    overrides: [
        {
            files: ['**/*.test.js', '**/*.spec.js'],
            rules: {
                'no-console': 'off'
            }
        }
    ]
};