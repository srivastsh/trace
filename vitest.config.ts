import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.ts','tests/**/*.spec.ts','tests/**/*.test.tsx'],exclude:['vendor/**','tests/integration/**','tests/visual/**']}});
