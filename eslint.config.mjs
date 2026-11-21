import typescriptConfig from '@playcanvas/eslint-config/typescript';

export default [
    ...typescriptConfig,
    {
        // preserve existing module initialization order
        files: [
            'src/cameras/anim-controller.ts',
            'src/cameras/fly-controller.ts',
            'src/cameras/walk-controller.ts',
            'src/index.ts'
        ],
        rules: {
            'import-x/order': 'off'
        }
    },
    {
        // These import build output — src/module imports the viewer files from public/, and
        // the tests import the bundled package from dist/ — which .gitignore excludes, so the
        // imports are absent on a clean checkout and the lint job does not build. The module
        // sources are type-checked via the ambient `declare module '*.css'` in types.d.ts.
        files: ['src/module/index.ts', 'src/module/render-html.ts', 'test/**/*.mjs'],
        rules: {
            'import-x/no-unresolved': 'off'
        }
    },
    {
        // Headless engine fakes: no-op gpu methods and single-constructor wrapper classes are the
        // point of the mock, and its import order differs from application modules
        files: ['test/module/helpers/**/*.mjs'],
        rules: {
            'import-x/order': 'off',
            'import-x/no-duplicates': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-extraneous-class': 'off'
        }
    }
];
