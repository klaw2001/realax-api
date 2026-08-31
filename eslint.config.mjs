import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'logs/**', 'public/**', 'prisma/**', 'forms/**']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
    {
        languageOptions: {
            globals: { ...globals.node, ...globals.jest },
            parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
        },
        rules: {
            'linebreak-style': ['error', 'unix'],
            quotes: ['error', 'single', { avoidEscape: true }],
            semi: ['error', 'never'],
            curly: 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ]
        }
    },
    {
        // Inherited Express-starter code: the demo modules under src/app and
        // the helper layer under src/@core. Both are replaced by real REALAX
        // modules (src/modules) and clients (src/lib) during Phase 0, so their
        // `any` usage and dead imports are surfaced but not blocking. New code
        // outside these paths gets the rules at error level.
        files: ['src/app/**/*.ts', 'src/@core/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': 'warn',
            '@typescript-eslint/no-unsafe-function-type': 'warn'
        }
    }
)
