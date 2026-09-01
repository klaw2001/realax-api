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
    }
)
